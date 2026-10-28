export type WorkerEnv = {
  Bindings: {
    ASSETS?: Fetcher;
    FIREBASE_PROJECT_ID?: string;
    HYPERDRIVE?: { readonly connectionString: string };
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
