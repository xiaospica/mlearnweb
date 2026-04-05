import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, theme as antTheme } from 'antd'
import AppLayout from '@/components/layout/AppLayout'
import HomePage from '@/pages/HomePage'
import ExperimentDetailPage from '@/pages/ExperimentDetailPage'
import ReportPage from '@/pages/ReportPage'
import TrainingRecordsPage from '@/pages/TrainingRecordsPage'
import TrainingDetailPage from '@/pages/TrainingDetailPage'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5 * 60 * 1000, retry: 1 },
  },
})

const lightTheme = {
  algorithm: antTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#1677ff',
    colorBgBase: '#f5f7fa',
    colorBgContainer: '#ffffff',
    colorBgElevated: '#ffffff',
    colorBorder: '#e5e7eb',
    colorText: '#1f2937',
    colorTextSecondary: '#6b7280',
    borderRadius: 8,
    fontFamily: "'Inter', -apple-system, 'Segoe UI', sans-serif",
    fontSize: 14,
  },
  components: {
    Table: {
      headerBg: '#fafbfc',
      rowHoverBg: '#f0f5ff',
      borderColor: '#f0f0f0',
    },
    Card: {
      colorBgContainer: '#ffffff',
      colorBorderSecondary: '#e8e8e8',
    },
  },
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={lightTheme}>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<AppLayout />}>
              <Route index element={<TrainingRecordsPage />} />
              <Route path="training/:id" element={<TrainingDetailPage />} />
              <Route path="experiments" element={<HomePage />} />
              <Route path="experiments/:expId" element={<ExperimentDetailPage />} />
              <Route path="report/:expId/:runId" element={<ReportPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ConfigProvider>
    </QueryClientProvider>
  )
}

export default App
