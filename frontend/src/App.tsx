import React from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConfigProvider, App as AntApp, theme as antTheme } from 'antd'
import AppLayout from '@/components/layout/AppLayout'
import HomePage from '@/pages/HomePage'
import ExperimentDetailPage from '@/pages/ExperimentDetailPage'
import ReportPage from '@/pages/ReportPage'
import TrainingRecordsPage from '@/pages/TrainingRecordsPage'
import TrainingDetailPage from '@/pages/TrainingDetailPage'
import TrainingComparePage from '@/pages/TrainingComparePage'
import HelpLayout from '@/pages/help/HelpLayout'
import FactorCategoriesPage from '@/pages/help/FactorCategoriesPage'
import Alpha158DocsPage from '@/pages/help/Alpha158DocsPage'
import Alpha101DocsPage from '@/pages/help/Alpha101DocsPage'
import Alpha191DocsPage from '@/pages/help/Alpha191DocsPage'
import LiveTradingPage from '@/pages/live-trading/LiveTradingPage'
import LiveTradingStrategyDetailPage from '@/pages/live-trading/LiveTradingStrategyDetailPage'
import WorkbenchHomePage from '@/pages/workbench/WorkbenchHomePage'
import WorkbenchCreatePage from '@/pages/workbench/WorkbenchCreatePage'
import WorkbenchMonitorPage from '@/pages/workbench/WorkbenchMonitorPage'

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
        <AntApp>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<AppLayout />}>
                <Route index element={<TrainingRecordsPage />} />
                <Route path="training/compare" element={<TrainingComparePage />} />
                <Route path="training/:id" element={<TrainingDetailPage />} />
                <Route path="experiments" element={<HomePage />} />
                <Route path="experiments/:expId" element={<ExperimentDetailPage />} />
                <Route path="report/:expId/:runId" element={<ReportPage />} />
                <Route path="live-trading" element={<LiveTradingPage />} />
                <Route
                  path="live-trading/:nodeId/:engine/:name"
                  element={<LiveTradingStrategyDetailPage />}
                />
                <Route path="workbench" element={<WorkbenchHomePage />} />
                <Route path="workbench/new" element={<WorkbenchCreatePage />} />
                <Route path="workbench/jobs/:jobId" element={<WorkbenchMonitorPage />} />
                <Route path="help" element={<HelpLayout />}>
                  <Route index element={<Navigate to="categories" replace />} />
                  <Route path="categories" element={<FactorCategoriesPage />} />
                  <Route path="alpha158" element={<Alpha158DocsPage />} />
                  <Route path="alpha101" element={<Alpha101DocsPage />} />
                  <Route path="alpha191" element={<Alpha191DocsPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AntApp>
      </ConfigProvider>
    </QueryClientProvider>
  )
}

export default App
