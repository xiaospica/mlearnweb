from pydantic_settings import BaseSettings
from typing import List
import os

_BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class Settings(BaseSettings):
    mlruns_dir: str = r"F:\Quant\code\qlib_strategy_dev\mlruns"
    database_url: str = f"sqlite:///{os.path.join(_BASE_DIR, 'mlearnweb.db')}"
    cors_origins: List[str] = ["http://localhost:5173", "http://localhost:3000"]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
