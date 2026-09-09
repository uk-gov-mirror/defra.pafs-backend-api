import { describe, it, expect, vi, beforeEach } from 'vitest'
import externalUpdateProposalStatus from './update-proposal-status.js'
import { HTTP_STATUS } from '../../../common/constants/index.js'
import { ProjectService } from '../../projects/services/project-service.js'

vi.mock('../../projects/services/project-service.js')

/**
 * Build a minimal Hapi-like response toolkit.
 * h.response(data).code(x) → { data, statusCode }
 */
function buildH() {
  return {
    h: {
      response: vi.fn((data) => ({
        data,
        code: vi.fn((statusCode) => ({ data, statusCode }))
      }))
    }
  }
}

/**
 * Build a minimal Hapi-like request object for the external proposals route.
 */
function buildRequest(proposals = [], overrides = {}) {
  return {
    payload: { proposals },
    metrics: { counter: vi.fn() },
    prisma: {
      pafs_core_states: {
        findFirst: vi.fn().mockResolvedValue({ state: 'submitted' })
      }
    },
    server: {
      logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
      }
    },
    ...overrides
  }
}

describe('externalUpdateProposalStatus route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ──────────────────────────────────────────────────────
  //  Route configuration
  // ──────────────────────────────────────────────────────
  describe('route configuration', () => {
    it('should use POST method', () => {
      expect(externalUpdateProposalStatus.method).toBe('POST')
    })

    it('should be at /api/v1/external/proposals/status', () => {
      expect(externalUpdateProposalStatus.path).toBe(
        '/api/v1/external/proposals/status'
      )
    })

    it('should have auth disabled (gateway handles Cognito)', () => {
      expect(externalUpdateProposalStatus.options.auth).toBe(false)
    })

    it('should be tagged with api and external', () => {
      expect(externalUpdateProposalStatus.options.tags).toEqual([
        'api',
        'external'
      ])
    })

    it('should have a description and notes', () => {
      expect(externalUpdateProposalStatus.options.description).toBeDefined()
      expect(externalUpdateProposalStatus.options.notes).toBeDefined()
    })

    it('should have payload validation', () => {
      expect(
        externalUpdateProposalStatus.options.validate.payload
      ).toBeDefined()
    })
  })

  // ──────────────────────────────────────────────────────
  //  Payload validation schema (tested directly via Joi)
  // ──────────────────────────────────────────────────────
  describe('payload validation', () => {
    const schema = externalUpdateProposalStatus.options.validate.payload

    it('should accept a valid single-proposal payload', async () => {
      const { error } = schema.validate({
        proposals: [{ referenceNumber: 'ANC501E-000A-001A', status: 'draft' }]
      })
      expect(error).toBeUndefined()
    })

    it('should accept mixed statuses in a batch', async () => {
      const { error } = schema.validate({
        proposals: [
          { referenceNumber: 'REF-001', status: 'draft' },
          { referenceNumber: 'REF-002', status: 'approved' }
        ]
      })
      expect(error).toBeUndefined()
    })

    it('should reject reference numbers with forward slashes', async () => {
      const { error } = schema.validate({
        proposals: [
          { referenceNumber: 'ANC501E/000A/001A', status: 'approved' }
        ]
      })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/word characters|hyphens/i)
    })

    it('should reject when proposals is missing', async () => {
      const { error } = schema.validate({})
      expect(error).toBeDefined()
      expect(error.message).toMatch(/proposals/i)
    })

    it('should reject an empty proposals array', async () => {
      const { error } = schema.validate({ proposals: [] })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/At least one proposal/i)
    })

    it('should reject a proposals array with more than 100 items', async () => {
      const proposals = Array.from({ length: 101 }, (_, i) => ({
        referenceNumber: `REF-${i}`,
        status: 'draft'
      }))
      const { error } = schema.validate({ proposals })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/maximum of 100/i)
    })

    it('should accept rejected status', async () => {
      const { error } = schema.validate({
        proposals: [{ referenceNumber: 'REF-001', status: 'rejected' }]
      })
      expect(error).toBeUndefined()
    })

    it('should reject a disallowed status', async () => {
      const { error } = schema.validate({
        proposals: [{ referenceNumber: 'REF-001', status: 'submitted' }]
      })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/draft|approved|rejected/i)
    })

    it('should reject an item missing referenceNumber', async () => {
      const { error } = schema.validate({
        proposals: [{ status: 'draft' }]
      })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/referenceNumber/i)
    })

    it('should reject an item missing status', async () => {
      const { error } = schema.validate({
        proposals: [{ referenceNumber: 'REF-001' }]
      })
      expect(error).toBeDefined()
      expect(error.message).toMatch(/status/i)
    })
  })

  // ──────────────────────────────────────────────────────
  //  Handler — all proposals succeed → HTTP 200
  // ──────────────────────────────────────────────────────
  describe('handler — all proposals succeed', () => {
    it('should return 200 with results for a single proposal', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({ id: 1n, state: 'approved' })

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.OK)
      expect(result.data).toEqual({
        results: [
          {
            referenceNumber: 'ANC501E-000A-001A',
            success: true,
            status: 'approved'
          }
        ]
      })
    })

    it('should normalise hyphens to slashes when calling getProjectByReference', async () => {
      const mockProject = { id: 2n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'draft' }
      ])

      await externalUpdateProposalStatus.options.handler(request, h)

      expect(
        ProjectService.prototype.getProjectByReference
      ).toHaveBeenCalledWith('ANC501E/000A/001A')
    })

    it('should handle mixed statuses in a batch — all succeed', async () => {
      const projects = [
        { id: 1n, reference_number: 'ANC501E/000A/001A' },
        { id: 2n, reference_number: 'ANC501E/000B/001A' }
      ]
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValueOnce(projects[0])
        .mockResolvedValueOnce(projects[1])
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' },
        { referenceNumber: 'ANC501E-000B-001A', status: 'draft' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.OK)
      expect(result.data.results).toHaveLength(2)
      expect(result.data.results[0]).toEqual({
        referenceNumber: 'ANC501E-000A-001A',
        success: true,
        status: 'approved'
      })
      expect(result.data.results[1]).toEqual({
        referenceNumber: 'ANC501E-000B-001A',
        success: true,
        status: 'draft'
      })
    })

    it('should call upsertProjectState with the per-proposal status', async () => {
      const mockProject = { id: 5n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      const upsertSpy = (ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({}))

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'draft' }
      ])

      await externalUpdateProposalStatus.options.handler(request, h)

      expect(upsertSpy).toHaveBeenCalledWith(5n, 'draft')
    })
  })

  // ──────────────────────────────────────────────────────
  //  Handler — all proposals fail → HTTP 422
  // ──────────────────────────────────────────────────────
  describe('handler — all proposals fail', () => {
    it('should return 422 when no proposals are found', async () => {
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(null)

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'MISSING-REF-001', status: 'draft' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(result.data).toEqual({
        errors: [
          {
            referenceNumber: 'MISSING-REF-001',
            errorCode: 'PROPOSAL_NOT_FOUND',
            message: `Proposal 'MISSING-REF-001' was not found`
          }
        ]
      })
    })

    it('should return 422 when the service throws for all proposals', async () => {
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockRejectedValue(new Error('DB error'))

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'REF-001', status: 'approved' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(result.data).toEqual({
        errors: [
          {
            referenceNumber: 'REF-001',
            errorCode: 'UPDATE_FAILED',
            message: `Failed to update status for proposal 'REF-001'`
          }
        ]
      })
    })

    it('should log an error when a service call throws', async () => {
      const dbError = new Error('Connection refused')
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockRejectedValue(dbError)

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'REF-001', status: 'draft' }
      ])

      await externalUpdateProposalStatus.options.handler(request, h)

      expect(request.server.logger.error).toHaveBeenCalledWith(
        {
          error: 'Connection refused',
          referenceNumber: 'REF-001',
          status: 'draft'
        },
        'External API: failed to update proposal status'
      )
    })

    it('should return 422 when upsertProjectState throws', async () => {
      const mockProject = { id: 3n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockRejectedValue(new Error('Write failed'))

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
    })
  })

  // ──────────────────────────────────────────────────────
  //  Handler — state guard (proposal not in submitted state)
  // ──────────────────────────────────────────────────────
  describe('handler — state guard', () => {
    it('should return 422 when the transition is not permitted', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue({
        state: 'draft'
      })

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(result.data).toEqual({
        errors: [
          {
            referenceNumber: 'ANC501E-000A-001A',
            errorCode: 'INVALID_STATE',
            message: `Proposal 'ANC501E-000A-001A' cannot be moved from 'draft' to 'approved'`
          }
        ]
      })
      expect(ProjectService.prototype.upsertProjectState).not.toHaveBeenCalled()
    })

    it('should return 207 when one transition is allowed and another is not', async () => {
      const project1 = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      const project2 = { id: 2n, reference_number: 'ANC501E/000B/001A' }

      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValueOnce(project1)
        .mockResolvedValueOnce(project2)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const h = {
        response: vi.fn().mockReturnValue({
          code: vi.fn().mockReturnValue({ statusCode: 207 })
        })
      }
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' },
        { referenceNumber: 'ANC501E-000B-001A', status: 'approved' }
      ])
      request.prisma.pafs_core_states.findFirst
        .mockResolvedValueOnce({ state: 'submitted' })
        .mockResolvedValueOnce({ state: 'draft' })

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(207)
      expect(ProjectService.prototype.upsertProjectState).toHaveBeenCalledTimes(
        1
      )
    })

    it.each([
      ['submitted', 'draft'],
      ['submitted', 'approved'],
      ['submitted', 'rejected'],
      ['approved', 'draft']
    ])('should allow %s → %s', async (currentState, targetStatus) => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: targetStatus }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue({
        state: currentState
      })

      await externalUpdateProposalStatus.options.handler(request, h)

      expect(ProjectService.prototype.upsertProjectState).toHaveBeenCalledWith(
        mockProject.id,
        targetStatus
      )
    })

    it.each([
      ['approved', 'rejected'],
      ['rejected', 'draft'],
      ['rejected', 'approved'],
      ['draft', 'approved'],
      ['draft', 'rejected']
    ])('should reject %s → %s', async (currentState, targetStatus) => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: targetStatus }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue({
        state: currentState
      })

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(result.data.errors[0].message).toContain(
        `cannot be moved from '${currentState}' to '${targetStatus}'`
      )
      expect(ProjectService.prototype.upsertProjectState).not.toHaveBeenCalled()
    })

    it('should reject any change to a proposal already in draft', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'rejected' }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue({
        state: 'draft'
      })

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(ProjectService.prototype.upsertProjectState).not.toHaveBeenCalled()
    })

    it('should treat re-sending the current status as an idempotent success', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'draft' }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue({
        state: 'draft'
      })

      await externalUpdateProposalStatus.options.handler(request, h)

      expect(ProjectService.prototype.upsertProjectState).toHaveBeenCalledWith(
        mockProject.id,
        'draft'
      )
    })

    it('should reject a transition when the project has no state record', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }
      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValue(mockProject)
      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const { h } = buildH()
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'draft' }
      ])
      request.prisma.pafs_core_states.findFirst.mockResolvedValue(null)

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(HTTP_STATUS.UNPROCESSABLE_ENTITY)
      expect(result.data.errors[0].message).toContain(
        "cannot be moved from 'unknown' to 'draft'"
      )
      expect(ProjectService.prototype.upsertProjectState).not.toHaveBeenCalled()
    })
  })

  // ──────────────────────────────────────────────────────
  //  Handler — partial success → HTTP 207
  // ──────────────────────────────────────────────────────
  describe('handler — partial success (207 Multi-Status)', () => {
    it('should return 207 when some proposals succeed and some fail (not found)', async () => {
      const mockProject = { id: 1n, reference_number: 'ANC501E/000A/001A' }

      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValueOnce(mockProject) // first succeeds
        .mockResolvedValueOnce(null) // second not found

      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const h = {
        response: vi.fn().mockReturnValue({
          code: vi.fn().mockReturnValue({ statusCode: 207 })
        })
      }
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'approved' },
        { referenceNumber: 'MISSING-001', status: 'draft' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(h.response).toHaveBeenCalledWith({
        results: [
          {
            referenceNumber: 'ANC501E-000A-001A',
            success: true,
            status: 'approved'
          },
          {
            referenceNumber: 'MISSING-001',
            success: false,
            errorCode: 'PROPOSAL_NOT_FOUND',
            message: `Proposal 'MISSING-001' was not found`
          }
        ]
      })
      expect(result.statusCode).toBe(207)
    })

    it('should return 207 when some proposals fail due to service error', async () => {
      const mockProject = { id: 4n, reference_number: 'ANC501E/000A/001A' }

      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValueOnce(mockProject)
        .mockRejectedValueOnce(new Error('Timeout'))

      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const h = {
        response: vi.fn().mockReturnValue({
          code: vi.fn().mockReturnValue({ statusCode: 207 })
        })
      }
      const request = buildRequest([
        { referenceNumber: 'ANC501E-000A-001A', status: 'draft' },
        { referenceNumber: 'REF-BAD', status: 'approved' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      expect(result.statusCode).toBe(207)
    })

    it('should process all items independently even when one fails', async () => {
      // 3 items: success, not-found, success
      const project1 = { id: 1n, reference_number: 'REF/001' }
      const project3 = { id: 3n, reference_number: 'REF/003' }

      ProjectService.prototype.getProjectByReference = vi
        .fn()
        .mockResolvedValueOnce(project1)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(project3)

      ProjectService.prototype.upsertProjectState = vi
        .fn()
        .mockResolvedValue({})

      const h = {
        response: vi.fn().mockReturnValue({
          code: vi.fn().mockReturnValue({ statusCode: 207 })
        })
      }
      const request = buildRequest([
        { referenceNumber: 'REF-001', status: 'approved' },
        { referenceNumber: 'MISSING', status: 'draft' },
        { referenceNumber: 'REF-003', status: 'approved' }
      ])

      const result = await externalUpdateProposalStatus.options.handler(
        request,
        h
      )

      // upsertProjectState called twice (once for each found project)
      expect(ProjectService.prototype.upsertProjectState).toHaveBeenCalledTimes(
        2
      )
      expect(result.statusCode).toBe(207)
    })
  })
})
