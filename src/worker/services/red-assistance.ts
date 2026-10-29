import {
  RedDraftSchema,
  RedSentDeclarationSchema,
  RedDraftCreateRequestSchema,
  RedDraftUpdateRequestSchema,
  RedSentDeclarationRequestSchema,
  UuidSchema,
  type RedDraft,
  type RedDraftLocale,
} from '../../shared/contracts';
import { AccountNotFoundError, lockAccounts, type CheckedOutClient, type TransactionDatabase } from '../db/client';
import { ApiError } from '../middleware/errors';

interface RedReportRow extends Record<string, unknown> {
  id: string;
  author_user_id: string;
  route: string;
  description: string;
  lat: number;
  lng: number;
  city_id: string;
  is_demo: boolean;
}

interface DraftRow extends Record<string, unknown> {
  report_id: string;
  locale: string;
  draft_text: string;
  sent_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ContactRow extends Record<string, unknown> {
  id: string;
  label: string;
  channel: string;
  value: string;
  source_label: string;
  source_url: string;
  verified_at: Date | string;
}

function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'The requested Red draft was not found.');
}

function notEligible(): never {
  throw new ApiError(403, 'NOT_ELIGIBLE', 'Only your non-demo RED reports can have a personal draft.');
}

function invalidInput(): never {
  throw new ApiError(400, 'INVALID_INPUT', 'The Red draft request is invalid.');
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError('Database returned an invalid Red draft timestamp.');
  return parsed.toISOString();
}

function timestampOrNull(value: Date | string | null): string | null {
  return value === null ? null : timestamp(value);
}

async function loadEligibleReport(
  client: CheckedOutClient,
  actorId: string,
  reportId: string,
  lockForUpdate = true,
) {
  if (lockForUpdate) {
    try {
      await lockAccounts(client, [actorId]);
    } catch (error) {
      if (error instanceof AccountNotFoundError) notFound();
      throw error;
    }
  }
  const result = await client.query<RedReportRow>(
    'SELECT id, author_user_id, route, description, lat, lng, city_id, is_demo FROM reports WHERE id = $1::uuid AND author_user_id = $2::text'
      + (lockForUpdate ? ' FOR UPDATE' : ''),
    [reportId, actorId],
  );
  const report = result.rows[0];
  if (!report) notFound();
  if (report.route !== 'RED' || report.is_demo) notEligible();
  return report;
}

function factualTemplate(locale: RedDraftLocale, report: RedReportRow): string {
  const description = report.description;
  const location = Number(report.lat).toFixed(5) + ', ' + Number(report.lng).toFixed(5);
  if (locale === 'de') {
    return [
      'Meldung eines möglichen Gefahrenhinweises in Heilbronn',
      '',
      'Beschreibung aus meinem Bericht: ' + description,
      'Kartenmarkierung des Berichts: ' + location,
      '',
      'Ich bitte um Prüfung dieses Hinweises. Dieser von einer Einwohnerin oder einem Einwohner erstellte Entwurf wurde nicht von der App versendet und bestätigt keinen Eingang oder eine Antwort.',
    ].join('\n');
  }
  return [
    'Report of a potential hazard in Heilbronn',
    '',
    'Description from my report: ' + description,
    'Report map pin: ' + location,
    '',
    'Please assess this report. This resident-prepared draft has not been sent by the app and does not confirm receipt or a response.',
  ].join('\n');
}

async function readDraft(client: CheckedOutClient, reportId: string, ownerId: string): Promise<RedDraft> {
  const draftResult = await client.query<DraftRow>(
    'SELECT report_id, locale, draft_text, sent_at, created_at, updated_at FROM red_personal_drafts WHERE report_id = $1::uuid AND owner_user_id = $2::text',
    [reportId, ownerId],
  );
  const draft = draftResult.rows[0];
  if (!draft) notFound();
  const contactsResult = await client.query<ContactRow>(
    'SELECT id, label, channel, value, source_label, source_url, verified_at FROM red_verified_contacts WHERE city_id = $2::text AND locale = $1::varchar AND active = true ORDER BY label COLLATE "C", channel, id LIMIT 20',
    [draft.locale, 'heilbronn'],
  );
  return RedDraftSchema.parse({
    reportId: draft.report_id.toLowerCase(),
    locale: draft.locale,
    text: draft.draft_text,
    sentAt: timestampOrNull(draft.sent_at),
    contacts: contactsResult.rows.map((contact) => ({
      id: contact.id.toLowerCase(),
      label: contact.label,
      channel: contact.channel,
      value: contact.value,
      sourceLabel: contact.source_label,
      sourceUrl: contact.source_url,
      verifiedAt: timestamp(contact.verified_at),
    })),
    createdAt: timestamp(draft.created_at),
    updatedAt: timestamp(draft.updated_at),
  });
}

/** Keeps one private draft per report owner; POST is create-if-absent and never resets edits. */
export class PostgresRedAssistanceService {
  constructor(private readonly database: TransactionDatabase) {}

  async get(actorId: string, reportId: string) {
    const parsed = UuidSchema.safeParse(reportId);
    if (!parsed.success) invalidInput();
    return this.database.withTransaction(async (client) => {
      await loadEligibleReport(client, actorId, parsed.data.toLowerCase(), false);
      return { draft: await readDraft(client, parsed.data.toLowerCase(), actorId) };
    });
  }

  async create(actorId: string, reportId: string, locale: unknown) {
    const parsedId = UuidSchema.safeParse(reportId);
    const parsedLocale = RedDraftCreateRequestSchema.safeParse({ locale });
    if (!parsedId.success || !parsedLocale.success) invalidInput();
    return this.database.withTransaction(async (client) => {
      const normalizedId = parsedId.data.toLowerCase();
      const report = await loadEligibleReport(client, actorId, normalizedId);
      const inserted = await client.query<{ report_id: string }>(
        'INSERT INTO red_personal_drafts (report_id, owner_user_id, locale, draft_text) VALUES ($1::uuid, $2::text, $3::varchar, $4::varchar) ON CONFLICT (report_id, owner_user_id) DO NOTHING RETURNING report_id',
        [normalizedId, actorId, parsedLocale.data.locale, factualTemplate(parsedLocale.data.locale, report)],
      );
      return {
        draft: await readDraft(client, normalizedId, actorId),
        responseStatus: inserted.rows.length > 0 ? 201 : 200,
      };
    });
  }

  async update(actorId: string, reportId: string, text: unknown) {
    const parsedId = UuidSchema.safeParse(reportId);
    const parsedText = RedDraftUpdateRequestSchema.safeParse({ text });
    if (!parsedId.success || !parsedText.success) invalidInput();
    return this.database.withTransaction(async (client) => {
      const normalizedId = parsedId.data.toLowerCase();
      await loadEligibleReport(client, actorId, normalizedId);
      const updated = await client.query<{ report_id: string }>(
        'UPDATE red_personal_drafts SET draft_text = $3::varchar, updated_at = clock_timestamp() WHERE report_id = $1::uuid AND owner_user_id = $2::text RETURNING report_id',
        [normalizedId, actorId, parsedText.data.text],
      );
      if (!updated.rows[0]) notFound();
      return { draft: await readDraft(client, normalizedId, actorId) };
    });
  }

  async declareSent(actorId: string, reportId: string, sent: unknown) {
    const parsedId = UuidSchema.safeParse(reportId);
    const parsedRequest = RedSentDeclarationRequestSchema.safeParse({ sent });
    if (!parsedId.success || !parsedRequest.success) invalidInput();
    return this.database.withTransaction(async (client) => {
      const normalizedId = parsedId.data.toLowerCase();
      await loadEligibleReport(client, actorId, normalizedId);
      const updated = await client.query<{ sent_at: Date | string }>(
        'UPDATE red_personal_drafts SET sent_at = COALESCE(sent_at, clock_timestamp()), updated_at = CASE WHEN sent_at IS NULL THEN clock_timestamp() ELSE updated_at END WHERE report_id = $1::uuid AND owner_user_id = $2::text RETURNING sent_at',
        [normalizedId, actorId],
      );
      const row = updated.rows[0];
      if (!row) notFound();
      return RedSentDeclarationSchema.parse({
        reportId: normalizedId,
        sentAt: timestamp(row.sent_at),
      });
    });
  }
}
