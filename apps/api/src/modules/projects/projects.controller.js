'use strict';

const service = require('./projects.service');
const { parsePagination } = require('../../utils/pagination');

async function list(req, res) {
  const pagination = parsePagination(req.query);
  const result = await service.list(req.membership.organizationId, pagination);
  res.status(200).json(result);
}

async function get(req, res) {
  const project = await service.getById(req.membership.organizationId, req.params.projectId);
  res.status(200).json({ project });
}

async function create(req, res) {
  const project = await service.create(
    req.membership.organizationId,
    req.auth.userId,
    req.body
  );
  res.status(201).json({ project });
}

async function update(req, res) {
  const project = await service.update(
    req.membership.organizationId,
    req.params.projectId,
    req.body
  );
  res.status(200).json({ project });
}

module.exports = { list, get, create, update };
