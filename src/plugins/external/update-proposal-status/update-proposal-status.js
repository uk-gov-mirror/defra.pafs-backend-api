import Joi from 'joi'
import { ProjectService } from '../../projects/services/project-service.js'
import { HTTP_STATUS } from '../../../common/constants/index.js'
import { PROJECT_STATUS } from '../../../common/constants/project.js'
import {
  buildSuccessResponse,
  buildErrorResponse
} from '../../../common/helpers/response-builder.js'
import { validationFailAction } from '../../../common/helpers/validation-fail-action.js'

/**
 * External API: Update Proposal Status
 *
 * Accepts one or more proposals, each with its own reference number and status.
 * This allows different proposals to be moved to different statuses in one call.
 *
 * Access is controlled at the CDP API Gateway level (Cognito client-credentials);
 * no additional token validation is needed here.
 *
 * AMIS / PD integration parity:
 *   - Single proposal  → one-item proposals array
 *   - Batch update     → multi-item proposals array (max 100)
 *   - Mixed statuses   → each item specifies its own status
 *
 * Error strategy: process all items, collect per-item errors, return 207
 * Multi-Status when some succeed and some fail; 200 when all succeed;
 * 422 when all fail; 400 when the payload itself is invalid.
 */

const ALLOWED_EXTERNAL_STATUSES = [
  PROJECT_STATUS.DRAFT,
  PROJECT_STATUS.APPROVED,
  PROJECT_STATUS.REJECTED
]

/**
 * Permitted state transitions driven by the external system (AIMS PD).
 *
 * Keyed by the project's CURRENT state; the value is the set of states AIMS PD
 * may move it to.
 *
 * `approved` → `draft` is the "back to draft" path: AIMS PD has returned the
 * proposal for further work, which makes it editable again for RMA users (see
 * EDITABLE_STATUSES).
 *
 * `draft` and `rejected` are deliberately absent as source states — a proposal
 * that is already editable in PAFS must not be mutated by the external system,
 * and a rejected proposal is terminal.
 */
const ALLOWED_EXTERNAL_TRANSITIONS = {
  [PROJECT_STATUS.SUBMITTED]: [
    PROJECT_STATUS.DRAFT,
    PROJECT_STATUS.APPROVED,
    PROJECT_STATUS.REJECTED
  ],
  [PROJECT_STATUS.APPROVED]: [PROJECT_STATUS.DRAFT]
}

/**
 * Determine whether AIMS PD may move a proposal from `currentState` to
 * `targetStatus`.
 *
 * Re-applying the state a proposal is already in is treated as valid so that
 * retries from AIMS PD are idempotent rather than reported as failures.
 *
 * @param {string|null} currentState - The project's current state
 * @param {string} targetStatus - The requested new status
 * @returns {boolean}
 */
const isTransitionAllowed = (currentState, targetStatus) => {
  if (currentState === targetStatus) {
    return true
  }
  return (ALLOWED_EXTERNAL_TRANSITIONS[currentState] ?? []).includes(
    targetStatus
  )
}

const proposalItemSchema = Joi.object({
  referenceNumber: Joi.string()
    .pattern(/^[\w-]+$/)
    .required()
    .label('Reference Number')
    .messages({
      'any.required': 'referenceNumber is required for each proposal',
      'string.pattern.base':
        'referenceNumber must contain only word characters or hyphens'
    }),
  status: Joi.string()
    .valid(...ALLOWED_EXTERNAL_STATUSES)
    .required()
    .label('Status')
    .messages({
      'any.only': `Status must be one of: ${ALLOWED_EXTERNAL_STATUSES.join(', ')}`,
      'any.required': 'status is required for each proposal'
    })
})

const externalUpdateProposalStatus = {
  method: 'POST',
  path: '/api/v1/external/proposals/status',
  options: {
    auth: false, // Cognito Bearer token validated by CDP API Gateway — not here
    description: 'Update proposal status (external)',
    notes:
      'Updates the status of one or more FCERM project proposals. ' +
      'Each proposal specifies its own reference number and target status (`draft`, `approved`, or `rejected`). ' +
      'A proposal may be moved from `submitted` to any of the three statuses, and from ' +
      '`approved` back to `draft` (which returns it to the RMA for editing). ' +
      'Proposals already in `draft`, and proposals that have been `rejected`, cannot be changed ' +
      'by the external system. ' +
      'Re-sending the status a proposal already holds is treated as a success so retries are idempotent. ' +
      'Authentication is handled by the CDP API Gateway using AWS Cognito ' +
      'client-credentials; this endpoint must NOT be called directly — ' +
      'always go via the public API Gateway. ' +
      'Returns per-item results; HTTP 207 is returned when at least one item fails.',
    tags: ['api', 'external'],
    validate: {
      payload: Joi.object({
        proposals: Joi.array()
          .items(proposalItemSchema)
          .min(1)
          .max(100)
          .required()
          .label('Proposals')
          .messages({
            'array.min': 'At least one proposal is required',
            'array.max':
              'A maximum of 100 proposals can be processed per request',
            'any.required': 'proposals is required'
          })
      }),
      failAction: validationFailAction
    },
    handler: async (request, h) => {
      const { proposals } = request.payload
      const projectService = new ProjectService(
        request.prisma,
        request.server.logger
      )

      const results = []
      let hasSuccess = false
      let hasFailure = false

      for (const { referenceNumber: raw, status } of proposals) {
        // Normalise: replace hyphens used as URL separators back to slashes
        const referenceNumber = raw.replaceAll('-', '/')

        try {
          const project =
            await projectService.getProjectByReference(referenceNumber)

          if (!project) {
            request.metrics.counter('externalStatusUpdateItem', 1, {
              outcome: 'not_found',
              status
            })
            results.push({
              referenceNumber: raw,
              success: false,
              errorCode: 'PROPOSAL_NOT_FOUND',
              message: `Proposal '${raw}' was not found`
            })
            hasFailure = true
            continue
          }

          const stateRecord = await request.prisma.pafs_core_states.findFirst({
            where: { project_id: Number(project.id) },
            select: { state: true }
          })
          const currentState = stateRecord?.state ?? null
          if (!isTransitionAllowed(currentState, status)) {
            request.metrics.counter('externalStatusUpdateItem', 1, {
              outcome: 'invalid_state',
              status
            })
            results.push({
              referenceNumber: raw,
              success: false,
              errorCode: 'INVALID_STATE',
              message: `Proposal '${raw}' cannot be moved from '${currentState ?? 'unknown'}' to '${status}'`
            })
            hasFailure = true
            continue
          }

          await projectService.upsertProjectState(project.id, status)

          request.metrics.counter('externalStatusUpdateItem', 1, {
            outcome: 'success',
            status
          })
          results.push({
            referenceNumber: raw,
            success: true,
            status
          })
          hasSuccess = true
        } catch (error) {
          request.server.logger.error(
            { error: error.message, referenceNumber: raw, status },
            'External API: failed to update proposal status'
          )
          request.metrics.counter('externalStatusUpdateItem', 1, {
            outcome: 'error',
            status
          })
          results.push({
            referenceNumber: raw,
            success: false,
            errorCode: 'UPDATE_FAILED',
            message: `Failed to update status for proposal '${raw}'`
          })
          hasFailure = true
        }
      }

      if (!hasSuccess && hasFailure) {
        // All failed — return 422 with full result set
        request.metrics.counter('externalStatusUpdateCall', 1, {
          outcome: 'all_failed'
        })
        return buildErrorResponse(
          h,
          HTTP_STATUS.UNPROCESSABLE_ENTITY,
          results.map(({ success: _s, ...rest }) => rest)
        )
      }

      if (hasSuccess && hasFailure) {
        // Partial success — 207 Multi-Status
        request.metrics.counter('externalStatusUpdateCall', 1, {
          outcome: 'partial'
        })
        return h.response({ results }).code(207)
      }

      // All succeeded
      request.metrics.counter('externalStatusUpdateCall', 1, {
        outcome: 'success'
      })
      return buildSuccessResponse(h, { results })
    }
  }
}

export default externalUpdateProposalStatus
