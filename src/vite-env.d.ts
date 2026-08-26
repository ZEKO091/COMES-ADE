/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GITHUB_CLIENT_ID?: string;
  readonly VITE_COMESADE_WEB_URL?: string;
  readonly VITE_COMESADE_PLANS_URL?: string;
  readonly VITE_COMESADE_SIGNUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
