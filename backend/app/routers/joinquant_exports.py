"""聚宽（JoinQuant）持仓 JSON 导出路由。

端点
----
- ``POST /api/training-records/{record_id}/joinquant-exports`` 触发导出
- ``GET  /api/training-records/{record_id}/joinquant-exports`` 列出该 record 全部导出
- ``GET  /api/joinquant-exports/{export_id}/download`` 下载 JSON 文件
- ``DELETE /api/joinquant-exports/{export_id}`` 删除一条导出（含磁盘文件）

设计：v1 同步生成，单次 1-5s。导出失败时返回 status='failed' 的 export 行
（不抛 5xx），让前端表格能展示失败原因，避免用户重复点击。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.models.database import TrainingRecord, get_db_session
from app.schemas.schemas import ApiResponse, JoinquantExportItem
from app.services import joinquant_export_service as svc

router = APIRouter(tags=["joinquant-exports"])


def _to_item(row) -> JoinquantExportItem:
    return JoinquantExportItem.model_validate(row)


@router.post(
    "/api/training-records/{record_id}/joinquant-exports",
    response_model=ApiResponse,
)
def create_export(record_id: int, db: Session = Depends(get_db_session)) -> ApiResponse:
    """触发生成聚宽 JSON。同步阻塞等待 1-5s 后返回新行。"""
    try:
        row = svc.generate_export(record_id, db)
    except svc.JoinquantExportError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    if row.status == "failed":
        # 失败也写了 DB 行，返回时让前端能拿到 error_msg 渲染
        return ApiResponse(success=False, message=row.error_msg or "导出失败", data=_to_item(row).model_dump(mode="json"))
    return ApiResponse(success=True, message="导出成功", data=_to_item(row).model_dump(mode="json"))


@router.get(
    "/api/training-records/{record_id}/joinquant-exports",
    response_model=ApiResponse,
)
def list_exports(record_id: int, db: Session = Depends(get_db_session)) -> ApiResponse:
    """列出该训练记录的全部导出（按 created_at 倒序）。"""
    record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail=f"训练记录 {record_id} 不存在")
    rows = svc.list_exports(record_id, db)
    return ApiResponse(
        success=True,
        message="",
        data=[_to_item(r).model_dump(mode="json") for r in rows],
    )


@router.get("/api/joinquant-exports/{export_id}/download")
def download_export(export_id: int, db: Session = Depends(get_db_session)):
    """直接下载 JSON 文件。Content-Disposition=attachment 触发浏览器下载。"""
    row = svc.get_export(export_id, db)
    if row is None:
        raise HTTPException(status_code=404, detail="导出不存在")
    if row.status != "ok" or not row.file_path:
        raise HTTPException(status_code=410, detail=f"导出失败或文件已删除: {row.error_msg or ''}")
    path = svc.get_export_path(export_id, db)
    if path is None:
        raise HTTPException(status_code=410, detail="文件已不存在（可能被外部清理）")
    return FileResponse(
        path=str(path),
        media_type="application/json",
        filename=row.file_name or path.name,
    )


@router.delete("/api/joinquant-exports/{export_id}", response_model=ApiResponse)
def delete_export(export_id: int, db: Session = Depends(get_db_session)) -> ApiResponse:
    ok = svc.delete_export(export_id, db)
    if not ok:
        raise HTTPException(status_code=404, detail="导出不存在")
    return ApiResponse(success=True, message="已删除", data=None)
