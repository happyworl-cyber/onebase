// React + TypeScript 示例
// 安装依赖: npm install axios

import React, { useState, useEffect } from 'react';
import axios from 'axios';

// 创建 API 客户端
const api = axios.create({
  baseURL: 'http://localhost:3000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

// 类型定义
interface User {
  id: number;
  name: string;
  email: string;
  age?: number;
  status?: string;
  created_at?: string;
}

interface QueryParams {
  status?: string;
  'age.gte'?: number;
  order?: string;
  limit?: number;
  offset?: number;
}

// API 封装
class OneBaseAPI {
  constructor(private schema: string = 'public') {}

  // 查询
  async find<T>(table: string, params?: QueryParams): Promise<T[]> {
    const { data } = await api.get(`/${this.schema}/${table}`, { params });
    return data;
  }

  // 单个查询
  async findOne<T>(table: string, id: number): Promise<T | null> {
    const { data } = await api.get(`/${this.schema}/${table}`, {
      params: { id, limit: 1 },
    });
    return data.length > 0 ? data[0] : null;
  }

  // 创建
  async create<T>(table: string, record: Partial<T>): Promise<T> {
    const { data } = await api.post(`/${this.schema}/${table}`, record);
    return data;
  }

  // 批量创建
  async createMany<T>(table: string, records: Partial<T>[]): Promise<T[]> {
    const { data } = await api.post(`/${this.schema}/${table}`, records);
    return data;
  }

  // 更新
  async update<T>(
    table: string,
    id: number,
    updates: Partial<T>
  ): Promise<T[]> {
    const { data } = await api.patch(`/${this.schema}/${table}`, updates, {
      params: { id },
    });
    return data;
  }

  // 批量更新
  async updateMany<T>(
    table: string,
    params: QueryParams,
    updates: Partial<T>
  ): Promise<T[]> {
    const { data } = await api.patch(`/${this.schema}/${table}`, updates, {
      params,
    });
    return data;
  }

  // 删除
  async delete<T>(table: string, id: number): Promise<T[]> {
    const { data } = await api.delete(`/${this.schema}/${table}`, {
      params: { id },
    });
    return data;
  }

  // 批量删除
  async deleteMany<T>(table: string, params: QueryParams): Promise<T[]> {
    const { data } = await api.delete(`/${this.schema}/${table}`, { params });
    return data;
  }
}

// React Hook 示例
function useUsers() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const db = new OneBaseAPI('public');

  // 获取用户列表
  const fetchUsers = async (params?: QueryParams) => {
    try {
      setLoading(true);
      setError(null);
      const data = await db.find<User>('users', params);
      setUsers(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // 创建用户
  const createUser = async (userData: Partial<User>) => {
    try {
      const newUser = await db.create<User>('users', userData);
      setUsers([newUser, ...users]);
      return newUser;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  };

  // 更新用户
  const updateUser = async (id: number, updates: Partial<User>) => {
    try {
      const updated = await db.update<User>('users', id, updates);
      setUsers(users.map((u) => (u.id === id ? updated[0] : u)));
      return updated[0];
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  };

  // 删除用户
  const deleteUser = async (id: number) => {
    try {
      await db.delete<User>('users', id);
      setUsers(users.filter((u) => u.id !== id));
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  return {
    users,
    loading,
    error,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  };
}

// 用户列表组件
function UserList() {
  const {
    users,
    loading,
    error,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
  } = useUsers();

  const [filters, setFilters] = useState<QueryParams>({
    order: 'created_at.desc',
    limit: 20,
  });

  const [formData, setFormData] = useState({
    name: '',
    email: '',
    age: '',
  });

  // 应用过滤器
  const handleFilter = () => {
    fetchUsers(filters);
  };

  // 提交表单
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createUser({
        name: formData.name,
        email: formData.email,
        age: formData.age ? parseInt(formData.age) : undefined,
      });
      setFormData({ name: '', email: '', age: '' });
      alert('用户创建成功！');
    } catch (err) {
      alert('创建失败！');
    }
  };

  // 处理更新
  const handleUpdate = async (user: User) => {
    const newName = prompt('输入新名字:', user.name);
    if (newName && newName !== user.name) {
      try {
        await updateUser(user.id, { name: newName });
        alert('更新成功！');
      } catch (err) {
        alert('更新失败！');
      }
    }
  };

  // 处理删除
  const handleDelete = async (user: User) => {
    if (window.confirm(`确定要删除 ${user.name} 吗？`)) {
      try {
        await deleteUser(user.id);
        alert('删除成功！');
      } catch (err) {
        alert('删除失败！');
      }
    }
  };

  if (loading) return <div>加载中...</div>;
  if (error) return <div>错误: {error}</div>;

  return (
    <div style={{ padding: '20px' }}>
      <h1>用户管理</h1>

      {/* 创建表单 */}
      <div style={{ marginBottom: '20px', padding: '20px', background: '#f5f5f5' }}>
        <h2>创建用户</h2>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="姓名"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            required
            style={{ marginRight: '10px' }}
          />
          <input
            type="email"
            placeholder="邮箱"
            value={formData.email}
            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
            required
            style={{ marginRight: '10px' }}
          />
          <input
            type="number"
            placeholder="年龄"
            value={formData.age}
            onChange={(e) => setFormData({ ...formData, age: e.target.value })}
            style={{ marginRight: '10px' }}
          />
          <button type="submit">创建</button>
        </form>
      </div>

      {/* 过滤器 */}
      <div style={{ marginBottom: '20px' }}>
        <h2>过滤</h2>
        <select
          value={filters.status || ''}
          onChange={(e) =>
            setFilters({ ...filters, status: e.target.value || undefined })
          }
          style={{ marginRight: '10px' }}
        >
          <option value="">所有状态</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
        </select>
        <input
          type="number"
          placeholder="最小年龄"
          value={filters['age.gte'] || ''}
          onChange={(e) =>
            setFilters({
              ...filters,
              'age.gte': e.target.value ? parseInt(e.target.value) : undefined,
            })
          }
          style={{ marginRight: '10px' }}
        />
        <button onClick={handleFilter}>应用过滤</button>
      </div>

      {/* 用户列表 */}
      <div>
        <h2>用户列表 ({users.length})</h2>
        {users.length === 0 ? (
          <p>没有用户</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f0f0f0' }}>
                <th style={{ padding: '10px', textAlign: 'left' }}>ID</th>
                <th style={{ padding: '10px', textAlign: 'left' }}>姓名</th>
                <th style={{ padding: '10px', textAlign: 'left' }}>邮箱</th>
                <th style={{ padding: '10px', textAlign: 'left' }}>年龄</th>
                <th style={{ padding: '10px', textAlign: 'left' }}>状态</th>
                <th style={{ padding: '10px', textAlign: 'left' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid #ddd' }}>
                  <td style={{ padding: '10px' }}>{user.id}</td>
                  <td style={{ padding: '10px' }}>{user.name}</td>
                  <td style={{ padding: '10px' }}>{user.email}</td>
                  <td style={{ padding: '10px' }}>{user.age || 'N/A'}</td>
                  <td style={{ padding: '10px' }}>{user.status || 'N/A'}</td>
                  <td style={{ padding: '10px' }}>
                    <button
                      onClick={() => handleUpdate(user)}
                      style={{ marginRight: '5px' }}
                    >
                      更新
                    </button>
                    <button onClick={() => handleDelete(user)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default UserList;

