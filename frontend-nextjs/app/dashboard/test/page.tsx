'use client'

import { useState } from 'react'
import axios from 'axios'

export default function TestPage() {
  const [backendStatus, setBackendStatus] = useState<string>('未检测')
  const [testResult, setTestResult] = useState<string>('')

  const checkBackend = async () => {
    setBackendStatus('检测中...')
    try {
      const response = await axios.get('http://localhost:3000/health', {
        timeout: 3000,
      })
      setBackendStatus('✅ 在线')
      setTestResult(JSON.stringify(response.data, null, 2))
    } catch (error: any) {
      setBackendStatus('❌ 离线')
      setTestResult(`错误: ${error.message}\n\n请确保后端正在运行:\ncd D:\\code\\onebase\ncargo run`)
    }
  }

  const testLogin = async () => {
    try {
      const response = await axios.post('http://localhost:3000/auth/login', {
        email: 'admin@example.com',
        password: 'Admin123',
      })
      setTestResult(
        '✅ 登录成功！\n\nToken: ' +
          response.data.token +
          '\n\n完整响应:\n' +
          JSON.stringify(response.data, null, 2)
      )
    } catch (error: any) {
      setTestResult(
        '❌ 登录失败:\n' +
          (error.response?.data?.error || error.message) +
          '\n\n提示：如果用户不存在，请先注册'
      )
    }
  }

  const testSchemas = async () => {
    const token = localStorage.getItem('token')
    if (!token) {
      setTestResult('❌ 请先登录获取 token')
      return
    }

    try {
      const response = await axios.get('http://localhost:3000/api/schemas', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      setTestResult('✅ Schemas:\n\n' + JSON.stringify(response.data, null, 2))
    } catch (error: any) {
      setTestResult(
        '❌ 请求失败:\n' +
          (error.response?.data?.error || error.message) +
          '\n\n状态码: ' +
          error.response?.status
      )
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-800">API 测试工具</h1>

      <div className="card p-6">
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-2">
              后端状态：
              <span className="font-semibold ml-2">{backendStatus}</span>
            </p>
            <button onClick={checkBackend} className="btn-primary">
              <i className="fas fa-heartbeat text-xs mr-2"></i>
              检测后端
            </button>
          </div>

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">
              快速测试
            </h3>
            <div className="flex flex-wrap gap-2">
              <button onClick={testLogin} className="btn-success">
                <i className="fas fa-sign-in-alt text-xs mr-2"></i>
                测试登录
              </button>
              <button onClick={testSchemas} className="btn-default">
                <i className="fas fa-database text-xs mr-2"></i>
                测试 Schemas
              </button>
            </div>
          </div>

          {testResult && (
            <div className="border-t pt-4">
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                测试结果
              </h3>
              <pre className="code-block text-xs">{testResult}</pre>
            </div>
          )}
        </div>
      </div>

      <div className="card p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">
          常见问题排查
        </h3>
        <div className="space-y-4 text-sm">
          <div>
            <h4 className="font-semibold text-gray-700 mb-2">
              1. 后端未启动
            </h4>
            <p className="text-gray-600 mb-2">
              在项目根目录运行：
            </p>
            <pre className="code-block">cargo run</pre>
          </div>

          <div>
            <h4 className="font-semibold text-gray-700 mb-2">
              2. 端口被占用
            </h4>
            <p className="text-gray-600 mb-2">检查端口占用：</p>
            <pre className="code-block">
              netstat -ano | findstr :3000{'\n'}
              netstat -ano | findstr :3001
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-gray-700 mb-2">
              3. 数据库连接失败
            </h4>
            <p className="text-gray-600 mb-2">
              检查 .env 文件中的 DATABASE_URL
            </p>
            <pre className="code-block">
              DATABASE_URL=postgresql://postgres:password@localhost:5432/onebase
            </pre>
          </div>

          <div>
            <h4 className="font-semibold text-gray-700 mb-2">
              4. CORS 错误
            </h4>
            <p className="text-gray-600">
              打开浏览器开发者工具（F12）→ Console 标签页查看详细错误
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
