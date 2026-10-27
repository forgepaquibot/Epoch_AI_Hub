'use strict';

const { sqlGet } = require('../db/database');

function createError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Resolve the user's active plan.
 *
 * Users without a valid active subscription receive the free plan.
 * Subscription details must come from the database, not the request.
 */
async function getUserEntitlements(userId) {
  const normalizedUserId = Number(userId);

  if (
    !Number.isSafeInteger(normalizedUserId) ||
    normalizedUserId <= 0
  ) {
    throw createError(
      'Authentication is required.',
      401,
      'AUTHENTICATION_REQUIRED'
    );
  }

  const subscription = await sqlGet(
    `SELECT sp.*
       FROM user_subscriptions us

       JOIN service_plans sp
         ON sp.plan_id = us.plan_id

      WHERE us.user_id = ?
        AND us.status IN ('active', 'trialing')
        AND datetime(us.starts_at) <= datetime('now')
        AND (
          us.ends_at IS NULL
          OR datetime(us.ends_at) > datetime('now')
        )
        AND sp.is_active = 1

      ORDER BY
        CASE us.status
          WHEN 'active' THEN 0
          ELSE 1
        END,
        us.starts_at DESC

      LIMIT 1`,
    [normalizedUserId]
  );

  if (subscription) {
    return {
      plan_id: subscription.plan_id,
      plan_key: subscription.plan_key,
      plan_name: subscription.name,

      allows_server_inference:
        Number(subscription.allows_server_inference) === 1,

      allows_hosted_providers:
        Number(subscription.allows_hosted_providers) === 1,

      monthly_server_token_limit:
        subscription.monthly_server_token_limit
    };
  }

  // Missing, expired, or inactive subscriptions default to free.
  const freePlan = await sqlGet(
    `SELECT *
       FROM service_plans
      WHERE plan_key = 'free'
        AND is_active = 1
      LIMIT 1`
  );

  // Fail closed if the free plan has not been configured.
  if (!freePlan) {
    return {
      plan_id: null,
      plan_key: 'unavailable',
      plan_name: 'Unavailable',
      allows_server_inference: false,
      allows_hosted_providers: false,
      monthly_server_token_limit: 0
    };
  }

  return {
    plan_id: freePlan.plan_id,
    plan_key: freePlan.plan_key,
    plan_name: freePlan.name,

    allows_server_inference:
      Number(freePlan.allows_server_inference) === 1,

    allows_hosted_providers:
      Number(freePlan.allows_hosted_providers) === 1,

    monthly_server_token_limit:
      freePlan.monthly_server_token_limit
  };
}

/**
 * Enforce whether a user may use a requested inference location.
 *
 * Device-local inference is available independently of the paid
 * server plan. Provider/model compatibility is checked elsewhere.
 */
async function assertRuntimeEntitlement(userId, runtimeLocation) {
  const supportedLocations = [
    'device_local',
    'server',
    'hosted'
  ];

  if (!supportedLocations.includes(runtimeLocation)) {
    throw createError(
      'Unsupported runtime location.',
      400,
      'INVALID_RUNTIME'
    );
  }

  if (runtimeLocation === 'device_local') {
    return {
      allowed: true,
      runtime_location: 'device_local',
      plan_key: null
    };
  }

  const entitlements = await getUserEntitlements(userId);

  if (
    runtimeLocation === 'server' &&
    !entitlements.allows_server_inference
  ) {
    throw createError(
      'Server inference requires a plan that includes server access. You can continue using compatible models on your own device.',
      403,
      'PLAN_UPGRADE_REQUIRED'
    );
  }

  if (
    runtimeLocation === 'hosted' &&
    !entitlements.allows_hosted_providers
  ) {
    throw createError(
      'Your current plan does not include hosted provider access.',
      403,
      'PLAN_UPGRADE_REQUIRED'
    );
  }

  return {
    allowed: true,
    runtime_location: runtimeLocation,
    plan_key: entitlements.plan_key
  };
}

module.exports = {
  getUserEntitlements,
  assertRuntimeEntitlement
};