from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # API Settings
    API_V1_PREFIX: str = "/api/v1"
    PROJECT_NAME: str = "Knowledge IDE API"
    VERSION: str = "0.1.0"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    RELOAD: bool = True

    # Database
    DATABASE_URL: str = "sqlite+aiosqlite:///./knowledge_ide.db"
    DATABASE_ECHO: bool = False

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # File Storage
    UPLOAD_DIR: str = "uploads"
    MAX_FILE_SIZE: int = 100 * 1024 * 1024  # 100MB
    ALLOWED_EXTENSIONS: set[str] = {
        ".pdf", ".docx", ".doc", ".txt", ".md",
        ".png", ".jpg", ".jpeg", ".pptx", ".html", ".htm"
    }

    # AI/LLM
    SILICONFLOW_API_KEY: str = ""
    SILICONFLOW_BASE_URL: str = "https://api.siliconflow.cn/v1"
    SILICONFLOW_OCR_MODEL: str = "deepseek-ai/DeepSeek-OCR"
    MOONSHOT_API_KEY: str = ""
    MOONSHOT_BASE_URL: str = "https://api.moonshot.cn/v1"
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = ""
    ANTHROPIC_API_KEY: str = ""
    DEEPSEEK_API_KEY: str = ""
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com"
    DEFAULT_MODEL: str = "Pro/MiniMaxAI/MiniMax-M2.5"
    EMBEDDING_MODEL: str = "Qwen/Qwen3-Embedding-8B"
    EMBEDDING_DIMENSIONS: int = 1024
    RERANK_MODEL: str = "Qwen/Qwen3-Reranker-8B"
    RERANK_ENABLED: bool = True
    RERANK_TOP_N: int = 24
    EMBEDDING_PDF_PAGE_WINDOW: int = 5
    OCR_ENABLED: bool = True
    OCR_RENDER_DPI: int = 160
    OCR_MAX_OUTPUT_CHARS: int = 24000
    OCR_TIMEOUT_SECONDS: float = 90.0
    LLM_TRUST_ENV_PROXY: bool = False
    DASHSCOPE_API_KEY: str = ""
    DASHSCOPE_BASE_URL: str = "https://dashscope.aliyuncs.com/api/v1"
    QWEN_VL_EMBEDDING_MODEL: str = "qwen3-vl-embedding"
    QWEN_VL_EMBEDDING_DIM: int = 2048
    QWEN_VL_EMBEDDING_OUTPUT_TYPE: str = "dense"
    QWEN_VL_EMBEDDING_BATCH: int = 20
    QWEN_VL_EMBEDDING_TIMEOUT_SECONDS: float = 120.0
    SEGMENT_VECTOR_DOCUMENT_MAX_CHARS: int = 2400
    QWEN_DOC_FALLBACK_ENABLED: bool = True

    # Available Models
    AVAILABLE_MODELS: dict = {
        "Pro/MiniMaxAI/MiniMax-M2.5": {"provider": "siliconflow", "thinking": False},
        "deepseek-ai/DeepSeek-OCR": {"provider": "siliconflow", "thinking": False, "vision": True},
        "Qwen/Qwen3-Embedding-8B": {"provider": "siliconflow", "embedding": True},
        "Qwen/Qwen3-Reranker-8B": {"provider": "siliconflow", "rerank": True},
        "kimi-latest": {"provider": "moonshot", "thinking": False},
        "moonshot-v1-8k": {"provider": "moonshot", "thinking": False},
        "moonshot-v1-32k": {"provider": "moonshot", "thinking": False},
        "moonshot-v1-128k": {"provider": "moonshot", "thinking": False},
        "kimi-k2-0905-preview": {"provider": "moonshot", "thinking": True},
        "kimi-k2-turbo-preview": {"provider": "moonshot", "thinking": True},
        # Backward compatibility for existing deployments
        "deepseek-chat": {"provider": "deepseek", "thinking": False},
        "deepseek-reasoner": {"provider": "deepseek", "thinking": True},
        "gpt-4o-mini": {"provider": "openai", "thinking": False},
        "gpt-4o": {"provider": "openai", "thinking": False},
        "claude-3-5-sonnet-20241022": {"provider": "anthropic", "thinking": False},
    }

    # Vector Store
    CHROMA_PERSIST_DIR: str = "chroma_db"

    # Visual Retrieval (multimodal long-document reading)
    VISUAL_RETRIEVAL_ENABLED: bool = True
    VISUAL_RETRIEVAL_MODEL: str = "deepseek-ai/DeepSeek-OCR"
    VISUAL_RETRIEVAL_MAX_PAGES_PER_FILE: int = 120
    VISUAL_RETRIEVAL_TOP_K: int = 4
    VISUAL_RETRIEVAL_CANDIDATES: int = 20
    VISUAL_RETRIEVAL_VISION_RERANK_CANDIDATES: int = 8
    VISUAL_RETRIEVAL_TIMEOUT_SECONDS: float = 18.0
    VISUAL_RETRIEVAL_TIMEOUT_RETRIES: int = 1
    VISUAL_RERANK_TIMEOUT_SECONDS: float = 10.0
    VISUAL_RERANK_TIMEOUT_RETRIES: int = 1
    VISUAL_DEEP_READ_PAGE_WINDOW: int = 1
    VISUAL_DEEP_READ_MAX_CHARS: int = 3500
    VISUAL_TEXT_ANCHOR_MAX_CHARS: int = 1200
    VISUAL_PAGE_IMAGE_DPI: int = 110
    VISUAL_PAGE_IMAGE_MAX_EDGE: int = 960
    VISUAL_PAGE_IMAGE_QUALITY: int = 72
    VISUAL_PAGE_ASSET_SUBDIR: str = "_page_assets"
    MM_PARSE_MODE: str = "local_first"
    MM_PARSE_SCORE_THRESHOLD: float = 0.72
    MM_FUSION_ENABLED: bool = True
    MM_TOPK_RERANK: int = 8
    WEB_FETCH_TIMEOUT_SECONDS: int = 20
    WEB_FETCH_USER_AGENT: str = "KnowledgeIDEBot/0.1"

    # Context & Compaction
    AUTO_COMPACT_ENABLED: bool = True
    TASK_STATE_MACHINE_ENABLED: bool = True
    LAYERED_AGENT_ENABLED: bool = True
    TOKEN_LEDGER_STRICT: bool = True
    TASK_REGISTRY_ENABLED: bool = True
    STEP_CATALOG_ENABLED: bool = True
    LANGGRAPH_RUNTIME_ENABLED: bool = True
    LEGACY_MODE_ROUTER_ENABLED: bool = False
    MODEL_CONTEXT_WINDOW_TOKENS: int = 256000
    COMPACT_TRIGGER_RATIO: float = 0.8
    COMPACT_TRIGGER_TOKENS: int = 80000
    COMPACT_FORCE_TOKENS: int = 110000
    COMPACT_TARGET_TOKENS: int = 55000
    DOC_CONTEXT_BUDGET_TOKENS: int = 18000
    VIEWPORT_EXCERPT_MAX_CHARS: int = 2400
    VIEWPORT_MEMORY_BUCKET_RATIO: float = 0.1
    RUNTIME_BUCKET_RATIO: float = 0.3
    RAW_DIALOGUE_BUCKET_RATIO: float = 0.3
    COMPACT_DIALOGUE_BUCKET_RATIO: float = 0.3
    EXECUTOR_TOOL_RESULT_BUDGET_TOKENS: int = 2400
    RAG_BILINGUAL_PARALLEL_ENABLED: bool = True
    RAG_CANDIDATE_TOPN: int = 240
    RAG_RERANK_TOPN: int = 60
    RAG_MAP_BATCH_SIZE: int = 10
    COMPACT_DURING_EXECUTION: bool = False
    COMPACT_HARD_EMERGENCY_RATIO: float = 0.95

    # CORS
    CORS_ORIGINS: list[str] = [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        "app://localhost",
        "null",
    ]

    # WebSocket
    WS_HEARTBEAT_INTERVAL: int = 30

    class Config:
        env_file = ".env"
        case_sensitive = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
