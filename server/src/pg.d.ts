declare module 'pg' {
  export type QueryResult = { rows: unknown[]; rowCount: number | null }
  export class Pool {
    constructor(config?: { connectionString?: string; max?: number })
    query(sql: string, params?: unknown[]): Promise<QueryResult>
    connect(): Promise<PoolClient>
    end(): Promise<void>
  }
  export class PoolClient {
    query(sql: string, params?: unknown[]): Promise<QueryResult>
    release(): void
  }
  export const types: {
    setTypeParser(oid: number, parser: (value: string | null) => unknown): void
  }
  const pg: { Pool: typeof Pool; types: typeof types }
  export default pg
}
