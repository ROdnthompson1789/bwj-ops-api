export type Bindings = {
  DB: D1Database;
  SECRETS: KVNamespace;
  ENVIRONMENT: string;
  WORKER_VERSION: string;
  TENANT_ID: string;
};
