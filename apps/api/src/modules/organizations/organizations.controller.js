'use strict';

const service = require('./organizations.service');
const { parsePagination } = require('../../utils/pagination');

async function list(req, res) {
  const pagination = parsePagination(req.query);
  const result = await service.listForUser(req.auth.userId, pagination);
  res.status(200).json(result);
}

async function get(req, res) {
  const org = await service.getById(req.membership.organizationId, req.membership.role);
  res.status(200).json({ organization: org });
}

async function create(req, res) {
  const org = await service.create(req.auth.userId, req.body);
  res.status(201).json({ organization: org });
}

async function update(req, res) {
  const org = await service.update(
    req.membership.organizationId,
    req.membership.role,
    req.body
  );
  res.status(200).json({ organization: org });
}

module.exports = { list, get, create, update };
