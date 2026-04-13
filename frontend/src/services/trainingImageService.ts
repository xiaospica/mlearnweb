import apiClient from './apiClient'

export interface UploadedImage {
  url: string
  filename: string
}

export const trainingImageService = {
  async upload(recordId: number, file: File): Promise<UploadedImage> {
    const form = new FormData()
    form.append('file', file)
    const res = await apiClient.post(`/training-records/${recordId}/images`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return res.data.data as UploadedImage
  },
}
