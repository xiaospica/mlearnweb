from pydantic_settings import BaseSettings
from typing import List, Set
from pathlib import Path
import os

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Settings(BaseSettings):
    mlruns_dir: str = r"F:\Quant\code\qlib_strategy_dev\mlruns"
    database_url: str = f"sqlite:///{os.path.join(_BASE_DIR, 'mlearnweb.db')}"
    cors_origins: List[str] = ["http://localhost:5173", "http://localhost:3000"]

    upload_dir: Path = Path(_BASE_DIR) / "uploads"
    max_image_size_mb: int = 10
    allowed_image_exts: Set[str] = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    orphan_grace_seconds: int = 300

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

(settings.upload_dir / "training_records").mkdir(parents=True, exist_ok=True)
