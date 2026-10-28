import { Client } from 'pg';
import {
  PostgresTransactionDatabase,
  type PostgresConnection,
  type PostgresConnectionPool,
  type TransactionDatabase,
} from './client';

export interface RequestPostgresClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    parameters?: unknown[],
  ): Promise<{ rows: readonly Row[]; rowCount: number | null; command: string }>;
  end(): Promise<void>;
}

export interface RequestScopedDatabase {
  readonly database: TransactionDatabase;
  close(): Promise<void>;
}

export type RequestPostgresClientFactory = (connectionString: string) => RequestPostgresClient;
export type RequestScopedDatabaseFactory = (connectionString: string) => RequestScopedDatabase;

function createNodePostgresClient(connectionString: string): RequestPostgresClient {
  const client = new Client({ connectionString });
  return {
    connect: async () => { await client.connect(); },
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      parameters?: unknown[],
    ) => {
      const result = await client.query<Row>(text, parameters);
      return { rows: result.rows, rowCount: result.rowCount, command: result.command };
    },
    end: () => client.end(),
  };
}

/** Creates one lazy pg client for a Worker request; Hyperdrive pools the origin connections. */
export function createRequestScopedDatabase(
  connectionString: string,
  createClient: RequestPostgresClientFactory = createNodePostgresClient,
): RequestScopedDatabase {
  const client = createClient(connectionString);
  let connectPromise: Promise<void> | undefined;
  let checkedOut = false;
  let unusable = false;
  let closed = false;

  const pool: PostgresConnectionPool = {
    async connect(): Promise<PostgresConnection> {
      if (closed || unusable) throw new Error('The request database connection is not available.');
      if (checkedOut) throw new Error('Concurrent database transactions in one request are not supported.');
      checkedOut = true;
      try {
        connectPromise ??= client.connect();
        await connectPromise;
      } catch (error) {
        checkedOut = false;
        unusable = true;
        throw error;
      }

      return {
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
          text: string,
          parameters?: unknown[],
        ) => {
          const result = await client.query<Row>(text, parameters);
          return { rows: result.rows, rowCount: result.rowCount, command: result.command };
        },
        release: (error?: Error) => {
          checkedOut = false;
          if (error) unusable = true;
        },
      };
    },
  };

  return {
    database: new PostgresTransactionDatabase(pool),
    async close() {
      if (closed) return;
      closed = true;
      if (!connectPromise) return;
      await connectPromise.catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}
