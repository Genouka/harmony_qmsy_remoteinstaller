const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { generateToken, authMiddleware, adminMiddleware } = require('../middleware/auth');

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const user = User.findByUsername(username);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  if (!User.verifyPassword(user, password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = generateToken(user);
  res.json({
    message: '登录成功',
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      access_token: user.access_token,
      user_id: user.user_id
    }
  });
});

router.post('/register', authMiddleware, adminMiddleware, (req, res) => {
  const { username, password, role = 'user' } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const existing = User.findByUsername(username);
  if (existing) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  try {
    const user = User.create({ username, password, role });
    res.status(201).json({ message: '用户创建成功', user });
  } catch (err) {
    res.status(500).json({ error: '创建用户失败', detail: err.message });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

router.get('/', authMiddleware, adminMiddleware, (req, res) => {
  const users = User.findAll();
  res.json({ users });
});

router.get('/:id', authMiddleware, (req, res) => {
  const user = User.findById(req.params.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({ user });
});

router.put('/:id', authMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ error: '无权修改此用户' });
  }

  const user = User.findById(targetId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const { access_token, user_id, role } = req.body;
  const updates = {};
  if (access_token !== undefined) updates.access_token = access_token;
  if (user_id !== undefined) updates.user_id = user_id;
  if (role !== undefined && req.user.role === 'admin') updates.role = role;

  const updated = User.update(targetId, updates);
  res.json({ message: '用户信息已更新', user: updated });
});

router.put('/:id/password', authMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ error: '无权修改此用户密码' });
  }

  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: '密码不能为空' });
  }

  User.updatePassword(targetId, password);
  res.json({ message: '密码已更新' });
});

router.delete('/:id', authMiddleware, adminMiddleware, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: '不能删除自己' });
  }

  const user = User.findById(targetId);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  User.delete(targetId);
  res.json({ message: '用户已删除' });
});

module.exports = router;
