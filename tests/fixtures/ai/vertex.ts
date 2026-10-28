import { exportPKCS8, generateKeyPair } from 'jose';

// Generated in memory for tests; this identity has no Google Cloud access.
export const testVertexKeys = await generateKeyPair('RS256', { extractable: true });
export const vertexAccessToken = 'test-only-vertex-access-token';
export const vertexIdentity = {
  projectId: 'iskra-test', issuer: 'https://iskra.test', subject: 'iskra-staging-worker', environment: 'staging',
  audience: '//iam.googleapis.com/projects/123456/locations/global/workloadIdentityPools/test-worker/providers/vertex',
  serviceAccountEmail: 'iskra-vertex-staging@iskra-test.iam.gserviceaccount.com', keyId: 'test-only-key',
  privateKey: await exportPKCS8(testVertexKeys.privateKey),
};
export const vertexAuthJson = JSON.stringify(vertexIdentity);

export function withVertexAuth(fetcher: typeof fetch): typeof fetch {
  return async (url, init) => {
    if (String(url) === 'https://sts.googleapis.com/v1/token') {
      return Response.json({ access_token: 'test-only-federated-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (String(url).startsWith('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/')) {
      return Response.json({ accessToken: vertexAccessToken, expireTime: new Date(Date.now() + 900_000).toISOString() });
    }
    return fetcher(url, init);
  };
}
