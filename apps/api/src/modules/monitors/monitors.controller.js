'use strict';

const service = require('./monitors.service');
const { parsePagination } = require('../../utils/pagination');
const { listMonitorsQuerySchema } = require('./monitors.validation');

async function list(req, res) {
  const pagination = parsePagination(req.query);
  const filters = listMonitorsQuerySchema.parse(req.query);
  const result = await service.list(
    req.membership.organizationId,
    req.params.projectId,
    pagination,
    filters
  );
  res.status(200).json(result);
}

async function get(req, res) {
  const monitor = await service.getById(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId
  );
  res.status(200).json({ monitor });
}

async function create(req, res) {
  const monitor = await service.create(
    req.membership.organizationId,
    req.params.projectId,
    req.body
  );
  res.status(201).json({ monitor });
}

async function update(req, res) {
  const monitor = await service.update(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId,
    req.body
  );
  res.status(200).json({ monitor });
}

async function pause(req, res) {
  const monitor = await service.setStatus(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId,
    'paused'
  );
  res.status(200).json({ monitor });
}

async function resume(req, res) {
  const monitor = await service.setStatus(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId,
    'active'
  );
  res.status(200).json({ monitor });
}

async function remove(req, res) {
  await service.remove(req.membership.organizationId, req.params.projectId, req.params.monitorId);
  res.status(204).send();
}

async function run(req, res) {
  const result = await service.runNow(
    req.membership.organizationId,
    req.params.projectId,
    req.params.monitorId
  );
  // 202 Accepted when enqueued for async processing; 200 when queue is disabled.
  res.status(result.enqueued ? 202 : 200).json(result);
}

module.exports = { list, get, create, update, pause, resume, remove, run };
