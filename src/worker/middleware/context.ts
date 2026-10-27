export type WorkerEnv = {
  Bindings: {
    FIREBASE_PROJECT_ID?: string;
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
