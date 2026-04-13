from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.models.database import TrainingRecord, get_db_session
from app.schemas.schemas import ApiResponse
from app.services import memo_image_service

router = APIRouter(prefix="/api/training-records", tags=["training-record-images"])


@router.post("/{record_id}/images", response_model=ApiResponse)
def upload_memo_image(
    record_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db_session),
):
    record = db.query(TrainingRecord).filter(TrainingRecord.id == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=f"训练记录 {record_id} 不存在")

    result = memo_image_service.save_image(record_id, file)
    return ApiResponse(success=True, message="图片已上传", data=result)
