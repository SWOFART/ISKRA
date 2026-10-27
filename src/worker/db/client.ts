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
