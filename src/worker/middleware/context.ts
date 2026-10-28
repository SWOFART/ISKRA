export type WorkerEnv = {
  Bindings: {
    ASSETS?: Fetcher;
    PHOTOS?: R2Bucket;
    FIREBASE_PROJECT_ID?: string;
    MEDIA_SIGNING_SECRET?: string;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL_ID?: string;
    HYPERDRIVE?: { readonly connectionString: string };
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
