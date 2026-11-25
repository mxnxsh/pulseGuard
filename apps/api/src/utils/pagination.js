'use strict';

const { z } = require('zod');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

// Query-string pagination schema. Coerces strings and enforces bounds.
const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/**
 * Parses pagination from a request query, applying safe defaults and bounds.
 * @param {Record<string, unknown>} query
 * @returns {{ page: number, pageSize: number, limit: number, offset: number }}
 */
function parsePagination(query) {
  const { page, pageSize } = paginationQuerySchema.parse(query || {});
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * Builds a standard paginated response envelope.
 * @param {unknown[]} data
 * @param {{ page: number, pageSize: number }} pagination
 * @param {number} total
 */
function paginated(data, { page, pageSize }, total) {
  return {
    data,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 0,
    },
  };
}

module.exports = { parsePagination, paginated, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
