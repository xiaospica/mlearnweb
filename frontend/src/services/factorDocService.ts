import apiClient from './apiClient'
import type { ApiSuccessResponse } from '@/types'

export interface FactorDoc {
  name: string
  expression: string
  description: string
  category: string
}

export interface BaseFunction {
  name: string
  syntax: string
  description: string
}

export interface Alpha158DocsResponse {
  factors: FactorDoc[]
  categories: Record<string, string>
  base_functions: BaseFunction[]
  total_count: number
}

export interface Alpha101DocsResponse {
  factors: FactorDoc[]
  base_functions: BaseFunction[]
  total_count: number
}

export interface Alpha191DocsResponse {
  factors: FactorDoc[]
  base_functions: BaseFunction[]
  total_count: number
}

export const factorDocService = {
  getAlpha158Docs(): Promise<ApiSuccessResponse<Alpha158DocsResponse>> {
    return apiClient.get('/factor-docs/alpha158').then((r) => r.data)
  },

  getAlpha101Docs(): Promise<ApiSuccessResponse<Alpha101DocsResponse>> {
    return apiClient.get('/factor-docs/alpha101').then((r) => r.data)
  },

  getAlpha191Docs(): Promise<ApiSuccessResponse<Alpha191DocsResponse>> {
    return apiClient.get('/factor-docs/alpha191').then((r) => r.data)
  },

  getFactorDetail(factorName: string): Promise<ApiSuccessResponse<FactorDoc>> {
    return apiClient.get(`/factor-docs/alpha158/${factorName}`).then((r) => r.data)
  },

  getCategories(): Promise<ApiSuccessResponse<Record<string, string>>> {
    return apiClient.get('/factor-docs/alpha158/categories').then((r) => r.data)
  },

  getFactorsByCategory(category: string): Promise<ApiSuccessResponse<{ category: string; factors: FactorDoc[] }>> {
    return apiClient.get(`/factor-docs/alpha158/category/${category}`).then((r) => r.data)
  },
}
