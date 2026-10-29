import {
  CreateMissionRequestSchema,
  type CreateMissionRequest,
  type Mission,
  ReportDetailSchema,
} from '../shared/contracts';
import type { Infer } from '../shared/schema';
import { ApiClientError, type ApiMode } from './api';
import type { SupportedLocale } from './designTokens';
import { formatDateTime, formatNumber, type MessageKey, type MessageValues } from './i18n';
import { createOperationKeyScope, type OperationKeyScope } from './operationKey';

type ReportDetail = Infer<typeof ReportDetailSchema>;
type Translate = (key: MessageKey, values?: MessageValues) => string;

export interface YellowMissionPanelOptions {
  apiMode: ApiMode;
  currentUserId: string | null;
  locale: SupportedLocale;
  t: Translate;
  onSignIn?: () => void;
  onLoadMission(reportId: string): Promise<Mission | null>;
  onCreateMission(reportId: string, input: CreateMissionRequest, operation: OperationKeyScope): Promise<Mission>;
  onJoinMission(missionId: string): Promise<Mission>;
  onUpdateAnnouncement(missionId: string, announcement: string): Promise<Mission>;
}

export interface YellowMissionPanelView {
  element: HTMLElement;
  setReport(report: ReportDetail): void;
  reset(): void;
  dispose(): void;
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function makeButton(label: string, className: string): HTMLButtonElement {
  const button = makeElement('button', className, label);
  button.type = 'button';
  return button;
}

function appendElements(parent: HTMLElement, ...elements: HTMLElement[]): void {
  for (const element of elements) parent.appendChild(element);
}

function labeledInput(
  labelText: string,
  type: string,
  value?: string,
  step?: string,
): { wrapper: HTMLLabelElement; input: HTMLInputElement } {
  const wrapper = makeElement('label', 'yellow-mission-field');
  const label = makeElement('span', undefined, labelText);
  const input = makeElement('input');
  input.type = type;
  input.required = true;
  if (value !== undefined) input.value = value;
  if (step) input.step = step;
  appendElements(wrapper, label, input);
  return { wrapper, input };
}

export function renderYellowMissionPanel(options: YellowMissionPanelOptions): YellowMissionPanelView {
  const element = makeElement('section', 'yellow-mission-panel');
  element.setAttribute('aria-labelledby', 'yellow-mission-heading');
  let currentReport: ReportDetail | null = null;
  let mission: Mission | null = null;
  let loadState: 'idle' | 'loading' | 'missing' | 'ready' | 'error' | 'fixture' = 'idle';
  let generation = 0;
  let createOperation: OperationKeyScope | null = null;
  let createAttemptBody: string | null = null;
  let disposed = false;
  let feedback = '';

  function render(): void {
    if (!currentReport) return;
    const reportId = currentReport.id;
    const heading = makeElement('h3', 'yellow-mission-heading', options.t('yellow.mission.heading'));
    heading.id = 'yellow-mission-heading';
    element.replaceChildren(heading);
    if (feedback) {
      const notice = makeElement('p', 'yellow-mission-feedback', feedback);
      notice.setAttribute('role', 'status');
      element.appendChild(notice);
    }

    if (loadState === 'fixture') {
      const state = makeElement('p', 'yellow-mission-status', options.t('yellow.mission.fixture'));
      state.setAttribute('role', 'status');
      element.appendChild(state);
      return;
    }
    if (loadState === 'loading') {
      const state = makeElement('p', 'yellow-mission-status', options.t('yellow.mission.loading'));
      state.setAttribute('role', 'status');
      element.appendChild(state);
      return;
    }
    if (loadState === 'error') {
      const state = makeElement('p', 'yellow-mission-status', options.t('yellow.mission.loadError'));
      state.setAttribute('role', 'status');
      const retry = makeButton(options.t('yellow.mission.retry'), 'secondary-button');
      retry.addEventListener('click', () => { void loadMission(reportId, generation); });
      appendElements(element, state, retry);
      return;
    }

    if (loadState === 'missing') {
      if (currentReport.status !== 'VERIFIED') {
        const state = makeElement('p', 'yellow-mission-status', options.t('yellow.mission.notEligible'));
        state.setAttribute('role', 'status');
        element.appendChild(state);
        return;
      }
      if (!options.currentUserId) {
        const state = makeElement('p', 'yellow-mission-status', options.t('yellow.mission.signInRequired'));
        state.setAttribute('role', 'status');
        const signIn = makeButton(options.t('yellow.mission.signIn'), 'secondary-button');
        signIn.addEventListener('click', () => options.onSignIn?.());
        appendElements(element, state, signIn);
        return;
      }

      const form = makeElement('form', 'yellow-mission-form');
      form.appendChild(makeElement('p', 'yellow-mission-description', options.t('yellow.mission.createDescription')));
      const startField = labeledInput(options.t('yellow.mission.startsAt'), 'datetime-local');
      const labelField = labeledInput(options.t('yellow.mission.meetingPoint'), 'text');
      labelField.input.maxLength = 160;
      const latitudeField = labeledInput(options.t('yellow.mission.latitude'), 'number', String(currentReport.location.lat), 'any');
      const longitudeField = labeledInput(options.t('yellow.mission.longitude'), 'number', String(currentReport.location.lng), 'any');
      const message = makeElement('p', 'yellow-mission-feedback');
      message.setAttribute('role', 'status');
      const create = makeButton(options.t('yellow.mission.create'), 'primary-button');
      create.type = 'submit';
      appendElements(form, startField.wrapper, labelField.wrapper, latitudeField.wrapper, longitudeField.wrapper, create, message);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (create.disabled) return;
        const startsAt = new Date(startField.input.value);
        const parsed = CreateMissionRequestSchema.safeParse({
          startsAt: Number.isNaN(startsAt.getTime()) ? '' : startsAt.toISOString(),
          meetingPoint: {
            lat: latitudeField.input.valueAsNumber,
            lng: longitudeField.input.valueAsNumber,
            label: labelField.input.value.trim(),
          },
        });
        if (!parsed.success) {
          message.textContent = options.t('error.INVALID_INPUT');
          return;
        }
        void createMission(reportId, parsed.data, create, message);
      });
      element.appendChild(form);
      return;
    }

    if (loadState !== 'ready' || !mission) return;

    const organizer = makeElement('p', 'yellow-mission-organizer', options.t('yellow.mission.organizer', {
      name: mission.organizer.nickname,
    }));
    const startsAt = makeElement('p', 'yellow-mission-start', options.t('yellow.mission.startsAtValue', {
      date: formatDateTime(options.locale, mission.startsAt),
    }));
    const meetingPoint = makeElement('p', 'yellow-mission-location', options.t('yellow.mission.meetingPointValue', {
      label: mission.meetingPoint.label,
      latitude: formatNumber(options.locale, mission.meetingPoint.lat),
      longitude: formatNumber(options.locale, mission.meetingPoint.lng),
    }));
    const participants = makeElement('p', 'yellow-mission-participants', options.t('yellow.mission.participants', {
      count: mission.participantCount,
    }));
    const announcementHeading = makeElement('h4', undefined, options.t('yellow.mission.announcement'));
    const announcement = makeElement('p', 'yellow-mission-announcement',
      mission.announcement || options.t('yellow.mission.noAnnouncement'));
    appendElements(element, organizer, startsAt, meetingPoint, participants, announcementHeading, announcement);

    if (options.currentUserId === mission.organizer.id) {
      const form = makeElement('form', 'yellow-mission-form yellow-mission-announcement-form');
      const label = makeElement('label', 'yellow-mission-field');
      const labelText = makeElement('span', undefined, options.t('yellow.mission.editAnnouncement'));
      const input = makeElement('textarea');
      input.maxLength = 500;
      input.value = mission.announcement;
      const missionId = mission.id;
      const actionGeneration = generation;
      appendElements(label, labelText, input);
      const message = makeElement('p', 'yellow-mission-feedback');
      message.setAttribute('role', 'status');
      const save = makeButton(options.t('yellow.mission.saveAnnouncement'), 'secondary-button');
      save.type = 'submit';
      appendElements(form, label, save, message);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (save.disabled) return;
        save.disabled = true;
        message.textContent = '';
        void options.onUpdateAnnouncement(missionId, input.value.trim()).then((updated) => {
          if (disposed || generation !== actionGeneration || currentReport?.id !== reportId
            || mission?.id !== missionId) return;
          mission = updated;
          feedback = options.t('yellow.mission.updated');
          render();
        }).catch(() => {
          if (disposed || generation !== actionGeneration || currentReport?.id !== reportId
            || mission?.id !== missionId) return;
          save.disabled = false;
          message.textContent = options.t('error.generic');
        });
      });
      if (feedback) message.textContent = feedback;
      element.appendChild(form);
    } else if (options.currentUserId) {
      const join = makeButton(options.t('yellow.mission.join'), 'secondary-button');
      const message = makeElement('p', 'yellow-mission-feedback');
      const missionId = mission.id;
      const actionGeneration = generation;
      message.setAttribute('role', 'status');
      join.addEventListener('click', () => {
        if (join.disabled) return;
        join.disabled = true;
        message.textContent = '';
        void options.onJoinMission(missionId).then((updated) => {
          if (disposed || generation !== actionGeneration || currentReport?.id !== reportId
            || mission?.id !== missionId) return;
          mission = updated;
          feedback = options.t('yellow.mission.joined');
          render();
        }).catch(() => {
          if (disposed || generation !== actionGeneration || currentReport?.id !== reportId
            || mission?.id !== missionId) return;
          join.disabled = false;
          message.textContent = options.t('error.generic');
        });
      });
      appendElements(element, join, message);
    } else {
      const signIn = makeButton(options.t('yellow.mission.signIn'), 'secondary-button');
      signIn.addEventListener('click', () => options.onSignIn?.());
      element.appendChild(signIn);
    }

    const deferred = makeElement('p', 'yellow-mission-deferred', options.t('yellow.mission.deferred'));
    deferred.setAttribute('role', 'note');
    element.appendChild(deferred);
  }

  async function loadMission(reportId: string, requestGeneration: number): Promise<void> {
    loadState = 'loading';
    render();
    try {
      const loadedMission = await options.onLoadMission(reportId);
      if (disposed || generation !== requestGeneration || currentReport?.id !== reportId) return;
      mission = loadedMission;
      loadState = mission ? 'ready' : 'missing';
      feedback = '';
    } catch {
      if (disposed || generation !== requestGeneration || currentReport?.id !== reportId) return;
      loadState = 'error';
    }
    render();
  }

  async function createMission(
    reportId: string,
    input: CreateMissionRequest,
    button: HTMLButtonElement,
    message: HTMLElement,
  ): Promise<void> {
    const requestGeneration = generation;
    const serializedInput = JSON.stringify(input);
    if (createAttemptBody !== serializedInput) {
      createOperation = null;
      createAttemptBody = serializedInput;
    }
    createOperation ??= createOperationKeyScope();
    button.disabled = true;
    message.textContent = '';
    try {
      const createdMission = await options.onCreateMission(reportId, input, createOperation);
      if (disposed || generation !== requestGeneration || currentReport?.id !== reportId) return;
      mission = createdMission;
      createOperation = null;
      createAttemptBody = null;
      loadState = 'ready';
      feedback = options.t('yellow.mission.created');
      render();
    } catch (error) {
      if (disposed || generation !== requestGeneration || currentReport?.id !== reportId) return;
      if (error instanceof ApiClientError && error.code === 'MISSION_ALREADY_EXISTS') {
        createOperation?.complete();
        createOperation = null;
        createAttemptBody = null;
        void loadMission(reportId, requestGeneration);
        return;
      }
      button.disabled = false;
      message.textContent = options.t('error.generic');
    }
  }

  return {
    element,
    setReport(report: ReportDetail) {
      if (report.route !== 'YELLOW') {
        generation += 1;
        currentReport = null;
        mission = null;
        loadState = 'idle';
        createOperation = null;
        createAttemptBody = null;
        feedback = '';
        element.hidden = true;
        return;
      }
      const changed = currentReport?.id !== report.id;
      currentReport = report;
      element.hidden = false;
      if (options.apiMode === 'fixture') {
        loadState = 'fixture';
        render();
        return;
      }
      if (changed) {
        generation += 1;
        mission = null;
        feedback = '';
        createOperation = null;
        createAttemptBody = null;
        void loadMission(report.id, generation);
      } else {
        render();
      }
    },
    reset() {
      generation += 1;
      currentReport = null;
      mission = null;
      loadState = 'idle';
      createOperation = null;
      createAttemptBody = null;
      feedback = '';
      element.hidden = true;
      element.replaceChildren();
    },
    dispose() {
      disposed = true;
      generation += 1;
      element.replaceChildren();
    },
  };
}
