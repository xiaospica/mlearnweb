import logging
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Dict, Optional, Set

from fastapi import HTTPException, UploadFile

from app.core.config import settings
from app.services.app_settings_service import get_runtime_setting

logger = logging.getLogger(__name__)

IMG_MD_RE = re.compile(r'!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)')

_CHUNK = 1024 * 1024


def _record_dir(record_id: int) -> Path:
    return settings.upload_dir / "training_records" / str(record_id)


def _url_prefix(record_id: int) -> str:
    return f"/uploads/training_records/{record_id}/"


def save_image(record_id: int, upload_file: UploadFile) -> Dict[str, str]:
    allowed_exts = set(
        get_runtime_setting(
            "allowed_image_exts",
            default=sorted(list(settings.allowed_image_exts)),
        )
    )
    max_image_size_mb = int(
        get_runtime_setting("max_image_size_mb", default=settings.max_image_size_mb)
    )

    ext = os.path.splitext(upload_file.filename or "")[1].lower()
    if ext not in allowed_exts:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的图片格式: {ext}，仅允许 {sorted(allowed_exts)}",
        )

    content_type = (upload_file.content_type or "").lower()
    if content_type and not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"非图片 Content-Type: {content_type}")

    target_dir = _record_dir(record_id)
    target_dir.mkdir(parents=True, exist_ok=True)

    stored_name = f"{uuid.uuid4().hex}{ext}"
    target_path = target_dir / stored_name
    max_bytes = max_image_size_mb * 1024 * 1024
    total = 0

    try:
        with target_path.open("wb") as f:
            while True:
                chunk = upload_file.file.read(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    f.close()
                    try:
                        target_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                    raise HTTPException(
                        status_code=400,
                        detail=f"图片超出大小限制 {max_image_size_mb}MB",
                    )
                f.write(chunk)
    finally:
        try:
            upload_file.file.close()
        except Exception:
            pass

    return {
        "url": f"{_url_prefix(record_id)}{stored_name}",
        "filename": stored_name,
    }


def extract_referenced_filenames(markdown: Optional[str], record_id: int) -> Set[str]:
    if not markdown:
        return set()
    prefix = _url_prefix(record_id)
    result: Set[str] = set()
    for m in IMG_MD_RE.finditer(markdown):
        url = m.group(1).strip()
        idx = url.find(prefix)
        if idx < 0:
            continue
        tail = url[idx + len(prefix):]
        if "/" in tail or "\\" in tail or not tail:
            continue
        result.add(tail)
    return result


def sync_orphans(record_id: int, new_memo: Optional[str]) -> int:
    target_dir = _record_dir(record_id)
    if not target_dir.exists():
        return 0

    referenced = extract_referenced_filenames(new_memo, record_id)
    grace_seconds = int(
        get_runtime_setting("orphan_grace_seconds", default=settings.orphan_grace_seconds)
    )
    grace_threshold = time.time() - grace_seconds
    deleted = 0

    try:
        with os.scandir(target_dir) as it:
            for entry in it:
                if not entry.is_file():
                    continue
                if entry.name in referenced:
                    continue
                try:
                    if entry.stat().st_mtime > grace_threshold:
                        continue
                    Path(entry.path).unlink(missing_ok=True)
                    deleted += 1
                except Exception as e:
                    logger.warning(f"[memo_image] 删除孤儿文件失败 {entry.path}: {e}")
    except Exception as e:
        logger.warning(f"[memo_image] 扫描目录失败 {target_dir}: {e}")

    return deleted


def delete_record_dir(record_id: int) -> None:
    target_dir = _record_dir(record_id)
    if not target_dir.exists():
        return
    try:
        shutil.rmtree(target_dir)
    except Exception as e:
        logger.warning(f"[memo_image] 级联清理目录失败 {target_dir}: {e}")
