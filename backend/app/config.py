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
        ".png", ".jpg", ".jpeg", ".pptx"
    }

    # AI/LLM
    OPENAI_API_KEY: str = ""
    ANTHROPIC_API_KEY: str = ""
    DEEPSEEK_API_KEY: str = ""
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com"
    DEFAULT_MODEL: str = "deepseek-chat"
    EMBEDDING_MODEL: str = "text-embedding-3-small"

    # Available Models
    AVAILABLE_MODELS: dict = {
        "deepseek-chat": {"provider": "deepseek", "thinking": False},
        "deepseek-reasoner": {"provider": "deepseek", "thinking": True},
        "gpt-4o-mini": {"provider": "openai", "thinking": False},
        "gpt-4o": {"provider": "openai", "thinking": False},
        "claude-3-5-sonnet-20241022": {"provider": "anthropic", "thinking": False},
    }

    # Vector Store
    CHROMA_PERSIST_DIR: str = "chroma_db"

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:5174"]

    # WebSocket
    WS_HEARTBEAT_INTERVAL: int = 30

    class Config:
        env_file = ".env"
        case_sensitive = True


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
