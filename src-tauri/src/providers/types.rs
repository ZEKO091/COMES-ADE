//! Shared types for AI provider accounts stored in the OS keyring.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Openai,
    Xai,
    Anthropic,
    Gemini,
    Cursor,
    Deepseek,
    Glm,
    Kimi,
    Droid,
    Aider,
    Kilo,
    Github,
    Pi,
    Qwen,
    Opencode,
    Openrouter,
    Antigravity,
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Xai => "xai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
            Self::Deepseek => "deepseek",
            Self::Glm => "glm",
            Self::Kimi => "kimi",
            Self::Droid => "droid",
            Self::Aider => "aider",
            Self::Kilo => "kilo",
            Self::Github => "github",
            Self::Pi => "pi",
            Self::Qwen => "qwen",
            Self::Opencode => "opencode",
            Self::Openrouter => "openrouter",
            Self::Antigravity => "antigravity",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" | "chatgpt" | "codex" => Ok(Self::Openai),
            "xai" | "grok" => Ok(Self::Xai),
            "anthropic" | "claude" => Ok(Self::Anthropic),
            "gemini" | "google" => Ok(Self::Gemini),
            "cursor" | "cursor-agent" | "agent" => Ok(Self::Cursor),
            "deepseek" => Ok(Self::Deepseek),
            "glm" | "zhipu" | "chatglm" | "z.ai" => Ok(Self::Glm),
            "kimi" | "moonshot" => Ok(Self::Kimi),
            "droid" | "factory" => Ok(Self::Droid),
            "aider" => Ok(Self::Aider),
            "kilo" | "kilo-cli" => Ok(Self::Kilo),
            "github" | "github-models" | "copilot" => Ok(Self::Github),
            "pi" => Ok(Self::Pi),
            "qwen" | "dashscope" | "alibaba" => Ok(Self::Qwen),
            "opencode" => Ok(Self::Opencode),
            "openrouter" => Ok(Self::Openrouter),
            "antigravity" | "agy" => Ok(Self::Antigravity),
            other => Err(format!("Proveedor desconocido: {other}")),
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Openai => "ChatGPT",
            Self::Xai => "Grok",
            Self::Anthropic => "Claude",
            Self::Gemini => "Gemini",
            Self::Cursor => "Cursor",
            Self::Deepseek => "DeepSeek",
            Self::Glm => "GLM",
            Self::Kimi => "Kimi",
            Self::Droid => "Droid",
            Self::Aider => "Aider",
            Self::Kilo => "Kilo",
            Self::Github => "GitHub Models",
            Self::Pi => "Pi",
            Self::Qwen => "Qwen",
            Self::Opencode => "OpenCode",
            Self::Openrouter => "OpenRouter",
            Self::Antigravity => "Antigravity",
        }
    }

    pub fn keyring_account(self) -> &'static str {
        match self {
            Self::Openai => "openai-user-credentials",
            Self::Xai => "xai-user-credentials",
            Self::Anthropic => "anthropic-user-credentials",
            Self::Gemini => "gemini-user-credentials",
            Self::Cursor => "cursor-user-credentials",
            Self::Deepseek => "deepseek-user-credentials",
            Self::Glm => "glm-user-credentials",
            Self::Kimi => "kimi-user-credentials",
            Self::Droid => "droid-user-credentials",
            Self::Aider => "aider-user-credentials",
            Self::Kilo => "kilo-user-credentials",
            Self::Github => "github-models-credentials",
            Self::Pi => "pi-user-credentials",
            Self::Qwen => "qwen-user-credentials",
            Self::Opencode => "opencode-user-credentials",
            Self::Openrouter => "openrouter-user-credentials",
            Self::Antigravity => "antigravity-user-credentials",
        }
    }

    pub fn env_key_name(self) -> &'static str {
        match self {
            Self::Openai | Self::Aider => "OPENAI_API_KEY",
            Self::Xai => "XAI_API_KEY",
            Self::Anthropic => "ANTHROPIC_API_KEY",
            Self::Gemini => "GEMINI_API_KEY",
            Self::Cursor => "CURSOR_API_KEY",
            Self::Deepseek => "DEEPSEEK_API_KEY",
            Self::Glm => "ZHIPUAI_API_KEY",
            Self::Kimi => "MOONSHOT_API_KEY",
            Self::Droid => "FACTORY_API_KEY",
            Self::Kilo => "KILO_API_KEY",
            Self::Github => "GITHUB_TOKEN",
            Self::Pi => "PI_API_KEY",
            Self::Qwen => "DASHSCOPE_API_KEY",
            Self::Opencode => "OPENCODE_API_KEY",
            Self::Openrouter => "OPENROUTER_API_KEY",
            Self::Antigravity => "ANTIGRAVITY_API_KEY",
        }
    }

    pub fn supports_oauth(self) -> bool {
        matches!(
            self,
            Self::Openai
                | Self::Xai
                | Self::Anthropic
                | Self::Cursor
                | Self::Droid
                | Self::Kilo
                | Self::Github
                | Self::Pi
                | Self::Opencode
                | Self::Antigravity
        )
    }

    pub fn supports_api_key(self) -> bool {
        !self.is_cli_agent()
    }

    pub fn oauth_hint(self) -> &'static str {
        match self {
            Self::Openai => "Abre el login real de ChatGPT / Codex en el navegador.",
            Self::Xai => "Abre accounts.x.ai y aprueba el codigo de Grok.",
            Self::Anthropic => "Abre el login real de Claude Code en el navegador.",
            Self::Gemini => "Google retiro el login consumer. Pega una API key de AI Studio.",
            Self::Cursor => "Se abre `agent login` oficial de Cursor, o pega CURSOR_API_KEY.",
            Self::Deepseek => "Pega una API key real de platform.deepseek.com.",
            Self::Glm => "Pega una API key real de open.bigmodel.cn.",
            Self::Kimi => "Pega una API key real de platform.moonshot.ai.",
            Self::Droid => "Abre Factory y pega FACTORY_API_KEY, o usa el CLI `droid`.",
            Self::Aider => "Aider usa API keys reales (OpenAI u otras). Pega la key aqui.",
            Self::Kilo => "Login oficial de Kilo CLI, o pega KILO_API_KEY.",
            Self::Github => "Usa tu GitHub conectado para Models, o pega un PAT con models.",
            Self::Pi => "Login del CLI `pi`, o pega PI_API_KEY.",
            Self::Qwen => "Pega una API key real de Alibaba Model Studio / DashScope.",
            Self::Opencode => "Se abre `opencode auth login`, o pega OPENCODE_API_KEY.",
            Self::Openrouter => "Pega una API key real de openrouter.ai/keys.",
            Self::Antigravity => "Login del CLI Antigravity, o pega la API key.",
        }
    }

    pub fn key_console_url(self) -> &'static str {
        match self {
            Self::Openai => "https://platform.openai.com/api-keys",
            Self::Xai => "https://console.x.ai",
            Self::Anthropic => "https://console.anthropic.com/settings/keys",
            Self::Gemini => "https://aistudio.google.com/apikey",
            Self::Cursor => "https://cursor.com/dashboard?tab=integrations",
            Self::Deepseek => "https://platform.deepseek.com/api_keys",
            Self::Glm => "https://open.bigmodel.cn/usercenter/apikeys",
            Self::Kimi => "https://platform.moonshot.ai/console/api-keys",
            Self::Droid => "https://app.factory.ai/settings/api-keys",
            Self::Aider => "https://aider.chat/docs/llms.html",
            Self::Kilo => "https://app.kilo.ai",
            Self::Github => "https://github.com/settings/tokens",
            Self::Pi => "https://pi.dev",
            Self::Qwen => "https://modelstudio.console.alibabacloud.com/",
            Self::Opencode => "https://opencode.ai",
            Self::Openrouter => "https://openrouter.ai/keys",
            Self::Antigravity => "https://antigravity.google",
        }
    }

    pub fn is_openai_compat(self) -> bool {
        matches!(
            self,
            Self::Deepseek | Self::Glm | Self::Kimi | Self::Qwen | Self::Openrouter | Self::Github
        )
    }

    pub fn is_cli_agent(self) -> bool {
        matches!(
            self,
            Self::Cursor
                | Self::Droid
                | Self::Aider
                | Self::Kilo
                | Self::Pi
                | Self::Opencode
                | Self::Antigravity
        )
    }

    pub fn chat_completions_url(self) -> Option<&'static str> {
        match self {
            Self::Deepseek => Some("https://api.deepseek.com/chat/completions"),
            Self::Glm => Some("https://open.bigmodel.cn/api/paas/v4/chat/completions"),
            Self::Kimi => Some("https://api.moonshot.ai/v1/chat/completions"),
            Self::Qwen => Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"),
            Self::Openrouter => Some("https://openrouter.ai/api/v1/chat/completions"),
            Self::Github => Some("https://models.github.ai/inference/chat/completions"),
            _ => None,
        }
    }

    pub fn default_model(self) -> &'static str {
        match self {
            Self::Deepseek => "deepseek-chat",
            Self::Glm => "glm-4.5",
            Self::Kimi => "kimi-k2.5",
            Self::Qwen => "qwen-plus",
            Self::Openrouter => "openrouter/auto",
            Self::Github => "openai/gpt-4.1",
            Self::Openai => "gpt-4.1",
            Self::Xai => "grok-4.6",
            Self::Anthropic => "claude-sonnet-4-5",
            Self::Gemini => "gemini-2.5-flash",
            _ => "default",
        }
    }

    pub fn all() -> &'static [Self] {
        &[
            Self::Openai,
            Self::Xai,
            Self::Anthropic,
            Self::Gemini,
            Self::Cursor,
            Self::Deepseek,
            Self::Glm,
            Self::Kimi,
            Self::Droid,
            Self::Aider,
            Self::Kilo,
            Self::Github,
            Self::Pi,
            Self::Qwen,
            Self::Opencode,
            Self::Openrouter,
            Self::Antigravity,
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub name: String,
    pub connected: bool,
    pub auth_mode: Option<String>,
    pub account_label: Option<String>,
    pub plan: Option<String>,
    pub reauth_required: bool,
    pub supports_oauth: bool,
    pub supports_api_key: bool,
    pub oauth_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResult {
    pub provider: String,
    pub verification_uri: Option<String>,
    pub user_code: Option<String>,
    pub expires_in: Option<u64>,
    pub interval_ms: Option<u64>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPollResult {
    pub provider: String,
    pub connected: bool,
    pub pending: bool,
    pub error: Option<String>,
    pub status: ProviderStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredProviderCredentials {
    pub auth_mode: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub api_key: Option<String>,
    pub access_token_expires_at: Option<u64>,
    pub account_label: Option<String>,
    pub plan: Option<String>,
    pub extra: Option<serde_json::Value>,
}

impl StoredProviderCredentials {
    pub fn from_api_key(api_key: String) -> Self {
        Self {
            auth_mode: "api_key".into(),
            access_token: None,
            refresh_token: None,
            api_key: Some(api_key),
            access_token_expires_at: None,
            account_label: None,
            plan: None,
            extra: None,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.api_key.as_ref().is_some_and(|k| !k.is_empty())
            || self.access_token.as_ref().is_some_and(|k| !k.is_empty())
            || self.auth_mode == "cli_login"
    }

    pub fn bearer(&self) -> Option<&str> {
        self.api_key
            .as_deref()
            .filter(|k| !k.is_empty())
            .or_else(|| self.access_token.as_deref().filter(|k| !k.is_empty()))
    }
}
