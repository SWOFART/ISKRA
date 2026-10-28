/** Result shape shared by SQL consumers without binding the domain to a driver. */
export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

/** A single checked-out client. Transaction consumers must use only this client. */
export interface CheckedOutClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

/** Transaction boundary expected by domain and evidence-store consumers. */
export interface TransactionDatabase {
  withTransaction<T>(work: (client: CheckedOutClient) => Promise<T>): Promise<T>;
}

/** PostgreSQL connection returned by either node-postgres Pool or a request-scoped Hyperdrive client. */
export interface PostgresConnection {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<QueryResult<Row> & { readonly command?: string }>;
  release(error?: Error): void;
}

export interface PostgresConnectionPool {
  connect(): Promise<PostgresConnection>;
}

/** A PostgreSQL-backed implementation that keeps BEGIN, work, and COMMIT on one checked-out client. */
export class PostgresTransactionDatabase implements TransactionDatabase {
  constructor(private readonly pool: PostgresConnectionPool) {}

  async withTransaction<T>(work: (client: CheckedOutClient) => Promise<T>): Promise<T> {
    const connection = await this.pool.connect();
    let transactionOpen = false;
    let transactionEndedByPostgres = false;
    let discardConnection: Error | undefined;

    try {
      await connection.query('BEGIN');
      transactionOpen = true;

      const client: CheckedOutClient = {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          parameters?: readonly unknown[],
        ): Promise<QueryResult<Row>> => {
          const result = await connection.query<Row>(text, parameters ? [...parameters] : undefined);
          return { rows: result.rows, rowCount: result.rowCount };
        },
      };

      const value = await work(client);
      const commit = await connection.query('COMMIT');
      transactionOpen = false;
      transactionEndedByPostgres = true;
      if (commit.command !== 'COMMIT') throw new TransactionAbortedError();
      return value;
    } catch (error) {
      if (!transactionOpen) {
        if (!transactionEndedByPostgres) discardConnection = asError(error);
        throw error;
      }

      try {
        await connection.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        discardConnection = asError(rollbackError);
        throw new AggregateError(
          [error, rollbackError],
          'Transaction failed and PostgreSQL rollback also failed; the connection was discarded.',
          { cause: error },
        );
      }
      throw error;
    } finally {
      connection.release(discardConnection);
    }
  }
}

export class TransactionAbortedError extends Error {
  constructor() {
    super('PostgreSQL rolled back the transaction instead of committing it.');
    this.name = 'TransactionAbortedError';
  }
}

/** Locks each existing account once in a stable bytewise UID order to avoid lock-order deadlocks. */
export async function lockAccounts(client: CheckedOutClient, accountIds: readonly string[]): Promise<readonly string[]> {
  const uniqueIds = [...new Set(accountIds)];
  if (uniqueIds.some((id) => id.trim() === '')) {
    throw new InvalidAccountLockError();
  }
  if (uniqueIds.length === 0) return [];

  const result = await client.query<{ id: string }>(
    'SELECT id FROM users WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE',
    [uniqueIds],
  );
  if (result.rows.length !== uniqueIds.length) {
    throw new AccountNotFoundError();
  }
  return result.rows.map(({ id }) => id);
}

export interface IdempotencyRequest {
  readonly actorId: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

/** Durable receipt identity. Dynamic state such as balances is intentionally not stored here. */
export interface IdempotencyReceipt {
  readonly resourceId: string;
  readonly responseStatus: number;
}

export interface IdempotentExecution<T> {
  readonly value: T;
  readonly receipt: IdempotencyReceipt;
}

export interface IdempotentResult<T> {
  readonly value: T;
  readonly responseStatus: number;
  readonly replayed: boolean;
}

/**
 * Claims an actor/operation/key inside the same transaction as the mutation.
 * Replays must load canonical state through `replay`; stored response bodies are never returned.
 */
export async function executeIdempotently<T>(
  database: TransactionDatabase,
  request: IdempotencyRequest,
  execute: (client: CheckedOutClient) => Promise<IdempotentExecution<T>>,
  replay: (client: CheckedOutClient, receipt: IdempotencyReceipt) => Promise<T>,
): Promise<IdempotentResult<T>> {
  return database.withTransaction(async (client) => {
    const claim = await client.query<{ user_id: string }>(
      `INSERT INTO idempotency_keys (user_id, operation, key, request_hash)
       VALUES ($1::text, $2::varchar, $3::varchar, $4::varchar)
       ON CONFLICT (user_id, operation, key) DO NOTHING
       RETURNING user_id`,
      [request.actorId, request.operation, request.key, request.requestHash],
    );

    if (claim.rowCount === 0) {
      const existing = await client.query<{
        request_hash: string;
        resource_id: string | null;
        response_status: number | null;
      }>(
        `SELECT request_hash, resource_id, response_status
         FROM idempotency_keys
         WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar
         FOR UPDATE`,
        [request.actorId, request.operation, request.key],
      );
      const row = existing.rows[0];
      if (!row) throw new MissingIdempotencyReceiptError();
      if (row.request_hash !== request.requestHash) throw new IdempotencyConflictError();
      if (!row.resource_id || row.response_status === null) throw new IncompleteIdempotencyReceiptError();

      const receipt = { resourceId: row.resource_id, responseStatus: row.response_status };
      return {
        value: await replay(client, receipt),
        responseStatus: receipt.responseStatus,
        replayed: true,
      };
    }

    const execution = await execute(client);
    await client.query(
      `UPDATE idempotency_keys
       SET resource_id = $4::uuid, response_status = $5, response_body = NULL
       WHERE user_id = $1::text AND operation = $2::varchar AND key = $3::varchar`,
      [request.actorId, request.operation, request.key, execution.receipt.resourceId,
        execution.receipt.responseStatus],
    );
    return {
      value: execution.value,
      responseStatus: execution.receipt.responseStatus,
      replayed: false,
    };
  });
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('The idempotency key was already used with a different request.');
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidAccountLockError extends Error {
  constructor() {
    super('Account identifiers must not be blank.');
    this.name = 'InvalidAccountLockError';
  }
}

export class AccountNotFoundError extends Error {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor() {
    super('One or more accounts to lock do not exist.');
    this.name = 'AccountNotFoundError';
  }
}

export class MissingIdempotencyReceiptError extends Error {
  constructor() {
    super('An idempotency key conflict occurred but its receipt was not readable.');
    this.name = 'MissingIdempotencyReceiptError';
  }
}

export class IncompleteIdempotencyReceiptError extends Error {
  constructor() {
    super('The stored idempotency record does not have a completed receipt.');
    this.name = 'IncompleteIdempotencyReceiptError';
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('PostgreSQL transaction failed.');
}
