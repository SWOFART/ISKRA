export type WorkerEnv = {
  Bindings: {
    ASSETS?: Fetcher;
    PHOTOS?: R2Bucket;
    FIREBASE_PROJECT_ID?: string;
    MEDIA_SIGNING_SECRET?: string;
    VERTEX_AUTH_JSON?: string;
    GEMINI_MODEL_ID?: string;
    HYPERDRIVE?: { readonly connectionString: string };
    RELEASE_SHA?: string;
  };
  Variables: {
    requestId: string;
    identity: { uid: string } | undefined;
  };
};
