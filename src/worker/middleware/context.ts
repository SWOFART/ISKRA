export type WorkerEnv = {
  Bindings: {
    ASSETS?: Fetcher;
    PHOTOS?: R2Bucket;
    MEDIA_SIGNING_SECRET?: string;
    FIREBASE_PROJECT_ID?: string;
    HYPERDRIVE?: { readonly connectionString: string };
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
