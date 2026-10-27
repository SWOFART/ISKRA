export type WorkerEnv = {
  Bindings: {
    ASSETS?: Fetcher;
    FIREBASE_PROJECT_ID?: string;
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
