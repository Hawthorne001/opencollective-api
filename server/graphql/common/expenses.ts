import assert from 'assert';

import * as LibTaxes from '@opencollective/taxes';
import config from 'config';
import debugLib from 'debug';
import type express from 'express';
import {
  cloneDeep,
  find,
  first,
  flatten,
  get,
  isBoolean,
  isEmpty,
  isEqual,
  isNil,
  isNumber,
  isUndefined,
  keyBy,
  mapValues,
  matches,
  min,
  omit,
  omitBy,
  pick,
  set,
  size,
  uniq,
} from 'lodash';
import moment from 'moment';
import { v4 as uuid } from 'uuid';

import { activities, expenseStatus, roles } from '../../constants';
import ActivityTypes from '../../constants/activities';
import { CollectiveType } from '../../constants/collectives';
import { Service } from '../../constants/connected-account';
import { SupportedCurrency } from '../../constants/currencies';
import { ExpenseFeesPayer } from '../../constants/expense-fees-payer';
import { ExpenseRoles } from '../../constants/expense-roles';
import FEATURE from '../../constants/feature';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../constants/paymentMethods';
import { EXPENSE_PERMISSION_ERROR_CODES } from '../../constants/permissions';
import PlatformConstants from '../../constants/platform';
import POLICIES from '../../constants/policies';
import { TransactionKind } from '../../constants/transaction-kind';
import cache from '../../lib/cache';
import { convertToCurrency, getDate, getFxRate, loadFxRatesMap } from '../../lib/currency';
import { simulateDBEntriesDiff } from '../../lib/data';
import errors from '../../lib/errors';
import { formatAddress } from '../../lib/format-address';
import logger from '../../lib/logger';
import { floatAmountToCents } from '../../lib/math';
import { fetchExpenseCategoryPredictions } from '../../lib/ml-service';
import { createRefundTransaction } from '../../lib/payments';
import { listPayPalTransactions } from '../../lib/paypal';
import { getPolicy } from '../../lib/policies';
import { reportErrorToSentry, reportMessageToSentry } from '../../lib/sentry';
import { notifyTeamAboutSpamExpense } from '../../lib/spam';
import { deepJSONBSet } from '../../lib/sql';
import { createTransactionsForManuallyPaidExpense, createTransactionsFromPaidExpense } from '../../lib/transactions';
import { CreateTransfer } from '../../lib/transferwise';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import { canUseFeature } from '../../lib/user-permissions';
import { formatCurrency, parseToBoolean } from '../../lib/utils';
import models, { Collective, sequelize, TransactionsImportRow, UploadedFile } from '../../models';
import AccountingCategory, { AccountingCategoryAppliesTo } from '../../models/AccountingCategory';
import Expense, {
  ExpenseDataValuesByRole,
  ExpenseLockableFields,
  ExpenseStatus,
  ExpenseTaxDefinition,
  ExpenseType,
} from '../../models/Expense';
import ExpenseAttachedFile from '../../models/ExpenseAttachedFile';
import ExpenseItem from '../../models/ExpenseItem';
import { MigrationLogType } from '../../models/MigrationLog';
import { PayoutMethodTypes } from '../../models/PayoutMethod';
import User from '../../models/User';
import paymentProviders from '../../paymentProviders';
import paypalAdaptive from '../../paymentProviders/paypal/adaptiveGateway';
import { Location } from '../../types/Location';
import {
  Quote as WiseQuote,
  QuoteV2 as WiseQuoteV2,
  QuoteV3 as WiseQuoteV3,
  RecipientAccount as BankAccountPayoutMethodData,
  Transfer as WiseTransfer,
} from '../../types/transferwise';
import { createUser } from '../common/user';
import {
  BadRequest,
  FeatureNotAllowedForUser,
  FeatureNotSupportedForCollective,
  Forbidden,
  NotFound,
  Unauthorized,
  ValidationFailed,
} from '../errors';
import { CurrencyExchangeRateSourceTypeEnum } from '../v2/enum/CurrencyExchangeRateSourceType';
import { fetchAccountWithReference } from '../v2/input/AccountReferenceInput';
import { AmountInputType, getValueInCentsFromAmountInput } from '../v2/input/AmountInput';
import { GraphQLCurrencyExchangeRateInputType } from '../v2/input/CurrencyExchangeRateInput';

import { getContextPermission, PERMISSION_TYPE } from './context-permissions';
import { checkScope } from './scope-check';
import { hasProtectedUrlPermission } from './uploaded-file';

const debug = debugLib('expenses');

const isOwner = async (req: express.Request, expense: Expense): Promise<boolean> => {
  expense.fromCollective = expense.fromCollective || (await req.loaders.Collective.byId.load(expense.FromCollectiveId));
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.id === expense.UserId && expense.fromCollective.type !== CollectiveType.VENDOR) {
    return true;
  } else if (!expense.fromCollective) {
    return false;
  }

  return req.remoteUser.isAdminOfCollective(expense.fromCollective);
};

const isOwnerAccountant = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  return req.remoteUser.hasRole(roles.ACCOUNTANT, expense.FromCollectiveId);
};

const isDraftPayee = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  const payeeReference = pick(expense.data?.payee, ['id', 'legacyId', 'slug']);

  if (isEmpty(payeeReference)) {
    if (expense.data?.payee?.email) {
      return req.remoteUser.email === expense.data.payee.email.toLowerCase();
    }

    return false;
  }

  const payee = await fetchAccountWithReference(payeeReference);
  if (!payee) {
    return false;
  }

  return req.remoteUser.isAdmin(payee.id);
};

const hasCorrectDraftKey =
  (draftKey?: string) =>
  async (req: express.Request, expense: Expense): Promise<boolean> => {
    return draftKey === expense.data.draftKey;
  };

const isHostAccountant = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (expense.HostCollectiveId) {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, expense.HostCollectiveId);
  }

  expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
  if (!expense.collective) {
    return false;
  } else {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, expense.collective.HostCollectiveId);
  }
};

const isCollectiveOrHostAccountant = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (req.remoteUser.hasRole(roles.ACCOUNTANT, expense.CollectiveId)) {
    return true;
  } else if (await isHostAccountant(req, expense)) {
    return true;
  }

  expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
  if (!expense.collective) {
    return false;
  } else if (expense.collective.ParentCollectiveId) {
    return req.remoteUser.hasRole(roles.ACCOUNTANT, expense.collective.ParentCollectiveId);
  } else {
    return false;
  }
};

const isPlatformAdmin = async (req: express.Request): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  return req.remoteUser.isAdminOfPlatform();
};

const isCollectiveAdmin = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }

  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
  }

  return req.remoteUser.isAdminOfCollective(expense.collective);
};

export const isHostAdmin = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (expense.HostCollectiveId) {
    return req.remoteUser.isAdmin(expense.HostCollectiveId);
  } else if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
    if (!expense.collective) {
      return false;
    }
  }

  return req.remoteUser.isAdmin(expense.collective.HostCollectiveId) && expense.collective.isActive;
};

const isAdminOrAccountantOfHostWhoPaidExpense = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  }
  return expense.HostCollectiveId && req.remoteUser.isAdmin(expense.HostCollectiveId);
};

const isAdminOfCollectiveWithPermissivePayoutMethodPermissions = async (
  req: express.Request,
  expense: Expense,
): Promise<boolean> => {
  if (!req.remoteUser || !(await isCollectiveAdmin(req, expense))) {
    return false;
  }

  // Make sure collective is loaded
  if (!expense.collective) {
    expense.collective = await req.loaders.Collective.byId.load(expense.CollectiveId);
    if (!expense.collective) {
      return false;
    }
  }

  const loosePermissionsPolicy = await getPolicy(
    expense.collective,
    POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS,
    { loaders: req.loaders },
  );

  return Boolean(loosePermissionsPolicy);
};

const isAdminOfCollectiveAndExpenseIsAVirtualCard = async (
  req: express.Request,
  expense: Expense,
): Promise<boolean> => {
  if (!req.remoteUser) {
    return false;
  } else if (expense.type !== ExpenseType.CHARGE) {
    return false;
  } else {
    return isCollectiveAdmin(req, expense);
  }
};

export type ExpensePermissionEvaluator = (
  req: express.Request,
  expense: Expense,
  options?: { throw?: boolean },
) => Promise<boolean>;

/**
 * Returns true if the expense meets at least one condition.
 * Always returns false for unauthenticated requests.
 */
const remoteUserMeetsOneCondition = async (
  req: express.Request,
  expense: Expense,
  conditions: ExpensePermissionEvaluator[],
  options: { throw?: boolean } = { throw: false },
): Promise<boolean> => {
  if (!req.remoteUser) {
    if (options?.throw) {
      throw new Forbidden('User is required', EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET);
    }
    return false;
  }

  for (const condition of conditions) {
    if (await condition(req, expense)) {
      return true;
    }
  }

  if (options?.throw) {
    throw new Forbidden(
      'You do not have the necessary permissions to perform this action',
      EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
    );
  }
  return false;
};

const validateExpenseScope = (req: express.Request, options: { throw?: boolean } = { throw: false }) => {
  if (!checkScope(req, 'expenses')) {
    if (options.throw) {
      throw new Forbidden(
        'You do not have the necessary scope to perform this action',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    } else {
      return false;
    }
  }

  return true;
};

// ---- Permissions ----
// Read permissions

/** Checks if the user can see expense's attachments (items URLs, attached files) */
export const canSeeExpenseAttachments: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isOwnerAccountant,
    isCollectiveAdmin, // Collective admins need to be able to check private notes, to verify that the receipt is for something legit to approve the expense; and they need to be able to upload documentation for virtual cards
    isCollectiveOrHostAccountant,
    isHostAdmin,
    isAdminOrAccountantOfHostWhoPaidExpense,
  ]);
};

/** Checks if the user can see expense's payout method private details (account number, PayPal email, ...etc) */
export const canSeeExpensePayoutMethodPrivateDetails: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  } else if (getContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, expense.PayoutMethodId)) {
    return true;
  }

  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isOwnerAccountant,
    isHostAdmin,
    isHostAccountant,
    isAdminOrAccountantOfHostWhoPaidExpense,
    isAdminOfCollectiveWithPermissivePayoutMethodPermissions, // Some fiscal hosts rely on the collective admins to do some verifications on the payout method
    isAdminOfCollectiveAndExpenseIsAVirtualCard, // Virtual cards are created by the collective admins
  ]);
};

/** Checks if the user can see expense's invoice information (the generated PDF) */
export const canSeeExpenseInvoiceInfo: ExpensePermissionEvaluator = async (
  req,
  expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  return remoteUserMeetsOneCondition(
    req,
    expense,
    [
      isOwner,
      isOwnerAccountant,
      isCollectiveAdmin,
      isCollectiveOrHostAccountant,
      isHostAdmin,
      isAdminOrAccountantOfHostWhoPaidExpense,
    ],
    options,
  );
};

/** Checks if the user can see expense's payout method */
export const canSeeExpensePayeeLocation: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isOwnerAccountant,
    isCollectiveAdmin,
    isCollectiveOrHostAccountant,
    isHostAdmin,
    isAdminOrAccountantOfHostWhoPaidExpense,
  ]);
};

export const canSeeExpenseSecurityChecks: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  // Preload host and collective, we'll need them for permissions checks
  expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
  if (expense.collective?.HostCollectiveId && !expense.collective.host) {
    expense.collective.host = await req.loaders.Collective.byId.load(expense.collective.HostCollectiveId);
  }

  // Only trusted hosts can use security checks
  if (!get(expense.collective, 'host.data.isTrustedHost')) {
    return false;
  }

  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin]);
};

export const canSeeDraftKey: ExpensePermissionEvaluator = async (req, expense) => {
  if (expense.status !== expenseStatus.DRAFT) {
    return false;
  }

  if (!validateExpenseScope(req)) {
    return false;
  }

  // Preload host and collective, we'll need them for permissions checks
  expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));
  if (expense.collective?.HostCollectiveId && !expense.collective.host) {
    expense.collective.host = await req.loaders.Collective.byId.load(expense.collective.HostCollectiveId);
  }

  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin]);
};

export const canSeeExpenseCustomData: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  return remoteUserMeetsOneCondition(req, expense, [
    isOwner,
    isCollectiveOrHostAccountant,
    isCollectiveAdmin,
    isHostAdmin,
    isAdminOrAccountantOfHostWhoPaidExpense,
  ]);
};

export const canUsePrivateNotes = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!validateExpenseScope(req)) {
    return false;
  }

  return isHostAdmin(req, expense);
};

export const canSeeExpenseDraftPrivateDetails: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  } else if (getContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_DRAFT_PRIVATE_DETAILS, expense.id)) {
    // We allow a context permission for unauthenticated users who provide the correct draft key
    return true;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [
      isCollectiveAdmin,
      isHostAdmin,
      isCollectiveOrHostAccountant,
      isAdminOrAccountantOfHostWhoPaidExpense,
      isDraftPayee,
      isOwner,
      isOwnerAccountant,
    ]);
  }
};

export const canSeeExpenseTransactionImportRow: ExpensePermissionEvaluator = async (req: express.Request, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  } else {
    return isHostAdmin(req, expense);
  }
};

/** Checks if the user can verify or resend a draft */
export const canVerifyDraftExpense: ExpensePermissionEvaluator = async (req, expense): Promise<boolean> => {
  if (!validateExpenseScope(req)) {
    return false;
  } else if (!['DRAFT', 'UNVERIFIED'].includes(expense.status)) {
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin]);
  }
};

// Write permissions

/**
 * Only the author or an admin of the collective or collective.host can edit an expense when it hasn't been paid yet
 */
export const canEditExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  }

  const nonEditableStatuses = ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT', 'CANCELED', 'INVITE_DECLINED'];

  // Host and expense owner can attach receipts to paid charge expenses
  if (expense.type === ExpenseType.CHARGE && ['PAID', 'PROCESSING'].includes(expense.status)) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  } else if (expense.status === 'DRAFT') {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isDraftPayee], options);
  } else if (nonEditableStatuses.includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not edit expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }
};

export const canEditTitle: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === ExpenseStatus.DRAFT) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.PENDING) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.APPROVED) {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  } else if (expense.status === ExpenseStatus.INCOMPLETE) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden('Can not edit title in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
  }
  return false;
};

export const canEditType: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.type !== ExpenseType.RECEIPT && expense.type !== ExpenseType.INVOICE) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not edit type for this type of expense (${expense.type})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_TYPE,
      );
    }
    return false;
  } else if (expense.status === ExpenseStatus.DRAFT) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.PENDING) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.APPROVED) {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  } else if (expense.status === ExpenseStatus.INCOMPLETE) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden('Can not edit type in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
  }
  return false;
};

export const canEditPaidBy: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === ExpenseStatus.DRAFT) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.PENDING) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin], options);
  } else if (expense.status === ExpenseStatus.APPROVED) {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  } else if (expense.status === ExpenseStatus.INCOMPLETE) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden('Can not edit paid by in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
  }
  return false;
};

export const canEditPayee: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === ExpenseStatus.DRAFT) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner], options);
  } else if (expense.status === ExpenseStatus.PENDING) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner], options);
  }

  if (options?.throw) {
    throw new Forbidden('Can not edit payee in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
  }
  return false;
};

export const canEditPayoutMethod: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (
    [ExpenseStatus.DRAFT, ExpenseStatus.PENDING, ExpenseStatus.INCOMPLETE].includes(expense.status as ExpenseStatus)
  ) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner], options);
  }

  if (options?.throw) {
    throw new Forbidden(
      'Can not edit payout method in current status',
      EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
    );
  }
  return false;
};

export const canEditItems: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === ExpenseStatus.DRAFT) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner], options);
  } else if (expense.status === ExpenseStatus.PENDING) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner], options);
  } else if (expense.status === ExpenseStatus.APPROVED) {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  } else if (expense.status === ExpenseStatus.INCOMPLETE) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden(
      'Can not edit expense items in current status',
      EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
    );
  }
  return false;
};

export const canAttachReceipts: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (
    [ExpenseStatus.PAID, ExpenseStatus.PROCESSING].includes(expense.status as ExpenseStatus) &&
    expense.type === ExpenseType.CHARGE
  ) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden('Can not attach receipts in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
  }
  return false;
};

export const canEditItemDescription: ExpensePermissionEvaluator = async (req, expense, options) => {
  if (!validateExpenseScope(req, options)) {
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot use expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (
    [ExpenseStatus.PAID, ExpenseStatus.PROCESSING].includes(expense.status as ExpenseStatus) &&
    expense.type === ExpenseType.CHARGE
  ) {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isHostAdmin, isCollectiveAdmin], options);
  }

  if (options?.throw) {
    throw new Forbidden(
      'Can not edit item description in current status',
      EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
    );
  }
  return false;
};

export const canEditExpenseTags: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot edit expense tags', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === 'PAID') {
    // Only collective/host admins can edit tags after the expense is paid
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isCollectiveAdmin], options);
  } else {
    return remoteUserMeetsOneCondition(
      req,
      expense,
      [isOwner, isOwnerAccountant, isHostAdmin, isCollectiveAdmin],
      options,
    );
  }
};

/**
 * Only the author or an admin of the collective or collective.host can delete an expense,
 * and only when its status is REJECTED.
 */
export const canDeleteExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (
    ['DRAFT', 'PENDING', 'INVITE_DECLINED'].includes(expense.status) &&
    (await remoteUserMeetsOneCondition(req, expense, [isOwner], options))
  ) {
    return true;
  } else if (!['REJECTED', 'SPAM', 'DRAFT', 'CANCELED'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not delete expense in current status',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot delete expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isOwner, isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be paid by user
 */
export const canPayExpense: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!['APPROVED', 'ERROR'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden('Can not pay expense in current status', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be approved by user
 */
export const canApprove: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!['PENDING', 'REJECTED', 'INCOMPLETE'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not approve expense in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot approve expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    expense.collective = expense.collective || (await req.loaders.Collective.byId.load(expense.CollectiveId));

    if (expense.collective.HostCollectiveId && expense.collective.approvedAt) {
      expense.collective.host =
        expense.collective.host || (await req.loaders.Collective.byId.load(expense.collective.HostCollectiveId));
    }

    const currency = expense.collective.host?.currency || expense.collective.currency;
    const hostPolicy = await getPolicy(expense.collective.host, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);
    const collectivePolicy = await getPolicy(expense.collective, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);

    let policy = collectivePolicy;
    if (hostPolicy.enabled && hostPolicy.appliesToHostedCollectives) {
      policy = hostPolicy;

      if (!hostPolicy.appliesToSingleAdminCollectives) {
        const collectiveAdminCount = await req.loaders.Member.countAdminMembersOfCollective.load(expense.collective.id);
        if (collectiveAdminCount === 1) {
          policy = collectivePolicy;
        }
      }
    }

    if (policy.enabled && expense.amount >= policy.amountInCents && req.remoteUser.id === expense.UserId) {
      if (options?.throw) {
        throw new Forbidden(
          'User cannot approve their own expenses',
          EXPENSE_PERMISSION_ERROR_CODES.AUTHOR_CANNOT_APPROVE,
          {
            reasonDetails: {
              amount: policy.amountInCents / 100,
              currency,
            },
          },
        );
      }
      return false;
    }
    if (expense.status === 'INCOMPLETE') {
      if (await isHostAdmin(req, expense)) {
        return true;
      } else {
        if (options?.throw) {
          throw new Forbidden(
            'Only host admins can approve incomplete expenses',
            EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET,
          );
        }
        return false;
      }
    }
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be rejected by user
 */
export const canReject: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!['PENDING', 'UNVERIFIED', 'INCOMPLETE'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not reject expense in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot reject expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    if (expense.type === ExpenseType.SETTLEMENT) {
      return remoteUserMeetsOneCondition(req, expense, [isPlatformAdmin], options);
    }

    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Creates an evaluator for an optional draftKey input that returns true if expense invite can be declined by this request
 */
export const buildCanDeclineExpenseInviteEvaluator: (draftKey?: string) => ExpensePermissionEvaluator =
  draftKey =>
  async (req: express.Request, expense: Expense, options = { throw: false }) => {
    if (req.remoteUser && !validateExpenseScope(req, options)) {
      if (options?.throw) {
        throw new Forbidden(
          'Your current token is missing the necessary scope',
          EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
        );
      }
      return false;
    } else if ('DRAFT' !== expense.status) {
      if (options?.throw) {
        throw new Forbidden(
          `Can not decline expense invite in current status (${expense.status})`,
          EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
        );
      }
      return false;
    } else if (req.remoteUser && !canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
      if (options?.throw) {
        throw new Forbidden(
          'User cannot decline expenses invites',
          EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
        );
      }
      return false;
    } else if (req.remoteUser) {
      if (await isDraftPayee(req, expense)) {
        return true;
      } else {
        if (options?.throw) {
          throw new Forbidden(
            'Only the invitee can decline the expense invite',
            EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
          );
        }
        return false;
      }
    } else if (!(await hasCorrectDraftKey(draftKey)(req, expense))) {
      if (options?.throw) {
        throw new Forbidden('Incorrect draft key', EXPENSE_PERMISSION_ERROR_CODES.MINIMAL_CONDITION_NOT_MET);
      }
      return false;
    }

    return true;
  };

/**
 * Returns true if expense can be rejected by user
 */
export const canMarkAsSpam: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!['REJECTED'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not mark expense as spam in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot mark expenses as spam', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.UserId === PlatformConstants.PlatformUserId) {
    if (options?.throw) {
      throw new Forbidden(
        'Cannot mark platform expenses as spam',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

/**
 * Returns true if expense can be unapproved by user
 */
export const canUnapprove: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (
    ![ExpenseStatus.INCOMPLETE, ExpenseStatus.APPROVED, ExpenseStatus.ERROR].includes(expense.status as ExpenseStatus)
  ) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not unapprove expense in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot unapprove expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else if (expense.status === ExpenseStatus.INCOMPLETE) {
    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  } else {
    return remoteUserMeetsOneCondition(req, expense, [isCollectiveAdmin, isHostAdmin], options);
  }
};

export const canMarkAsIncomplete: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!['APPROVED', 'ERROR'].includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not mark expense as incomplete in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot mark expense as incomplete',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else if (!(await isHostAdmin(req, expense))) {
    if (options?.throw) {
      throw new Forbidden(
        'Only host admins can mark expenses as incomplete',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else if (expense.type === ExpenseType.SETTLEMENT) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not mark settlement expense as incomplete`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  }

  return true;
};

/**
 * Returns true if user is allowed to change the accounting category of the expense
 */
export const canEditExpenseAccountingCategory = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
): Promise<boolean> => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot edit accounting categories for expenses',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  }

  // Host admins and accountants can always change the accounting category.
  if (await remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isHostAccountant])) {
    return true;
  }

  // Other roles can only change the accounting category if the expense is not paid yet
  const nonEditableStatuses = ['PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT', 'CANCELED'];
  if (nonEditableStatuses.includes(expense.status)) {
    if (options?.throw) {
      throw new Forbidden(
        `Can not change accounting category in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  }

  // Always allow for collective admins
  if (await isCollectiveAdmin(req, expense)) {
    return true;
  }

  // Otherwise, fallback to the default edit expense permissions
  return canEditExpense(req, expense, options);
};

/**
 * Returns true if expense can be marked as unpaid by user
 */
export const canMarkAsUnpaid: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (expense.status !== 'PAID') {
    if (options?.throw) {
      throw new Forbidden(
        `Can not mark expense as unpaid in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (expense.type === ExpenseType.CHARGE) {
    if (options?.throw) {
      throw new Forbidden(
        'Can not mark this type of expense as unpaid',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_TYPE,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden(
        'User cannot mark expenses as unpaid',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE,
      );
    }
    return false;
  } else {
    if (expense.type === ExpenseType.SETTLEMENT) {
      return remoteUserMeetsOneCondition(req, expense, [isPlatformAdmin], options);
    }

    return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
  }
};

/**
 * Returns true if user can comment and see others comments for this expense
 */
export const canComment: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!canUseFeature(req.remoteUser, FEATURE.USE_EXPENSES)) {
    if (options?.throw) {
      throw new Forbidden('User cannot pay expenses', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_USER_FEATURE);
    }
    return false;
  } else {
    return remoteUserMeetsOneCondition(
      req,
      expense,
      [isCollectiveAdmin, isHostAdmin, isOwner, isOwnerAccountant, isCollectiveOrHostAccountant],
      options,
    );
  }
};

export const canViewRequiredLegalDocuments: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [
    isHostAdmin,
    isHostAccountant,
    isOwner,
    isOwnerAccountant,
    isAdminOrAccountantOfHostWhoPaidExpense,
  ]);
};

export const canDownloadTaxForm: ExpensePermissionEvaluator = async (req, expense) => {
  if (!validateExpenseScope(req)) {
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin, isHostAccountant]);
};

export const canUnschedulePayment: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (expense.status !== 'SCHEDULED_FOR_PAYMENT') {
    if (options?.throw) {
      throw new Forbidden(
        `Can not unschedule expense for payment in current status (${expense.status})`,
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
};

export const canPutOnHold: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (expense.status !== 'APPROVED' || expense.onHold === true) {
    if (options?.throw) {
      throw new Forbidden(
        'Only approved expenses that are not on hold can be put on hold',
        EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS,
      );
    }
    return false;
  } else if (expense.type === ExpenseType.SETTLEMENT) {
    if (options?.throw) {
      throw new Forbidden(`Can not put settlement expense on hold`, EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
};

export const canReleaseHold: ExpensePermissionEvaluator = async (
  req: express.Request,
  expense: Expense,
  options = { throw: false },
) => {
  if (!validateExpenseScope(req, options)) {
    if (options?.throw) {
      throw new Forbidden(
        'Your current token is missing the necessary scope',
        EXPENSE_PERMISSION_ERROR_CODES.INVALID_SCOPE,
      );
    }
    return false;
  } else if (!expense.onHold) {
    if (options?.throw) {
      throw new Forbidden('Only expenses on hold can be released', EXPENSE_PERMISSION_ERROR_CODES.UNSUPPORTED_STATUS);
    }
    return false;
  }
  return remoteUserMeetsOneCondition(req, expense, [isHostAdmin], options);
};

export const canSeeExpenseOnHoldFlag = async (req: express.Request, expense: Expense): Promise<boolean> => {
  if (!validateExpenseScope(req)) {
    return false;
  }
  return isHostAdmin(req, expense);
};

// ---- Expense actions ----

export const approveExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'APPROVED') {
    return expense;
  } else if (!(await canApprove(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'APPROVED', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_APPROVED, req.remoteUser);
  return updatedExpense;
};

export const unapproveExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'PENDING') {
    return expense;
  } else if (!(await canUnapprove(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'PENDING', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNAPPROVED, req.remoteUser);
  return updatedExpense;
};

export const requestExpenseReApproval = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'PENDING') {
    return expense;
  } else if (!(await canUnapprove(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'PENDING', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED, req.remoteUser);
  return updatedExpense;
};

export const markExpenseAsIncomplete = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'INCOMPLETE') {
    return expense;
  } else if (!(await canMarkAsIncomplete(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({
    status: 'INCOMPLETE',
    lastEditedById: req.remoteUser.id,
    onHold: false,
  });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE, req.remoteUser);
  return updatedExpense;
};

export const rejectExpense = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'REJECTED') {
    return expense;
  } else if (!(await canReject(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'REJECTED', lastEditedById: req.remoteUser.id });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_REJECTED, req.remoteUser);
  return updatedExpense;
};

export const markAsPaidWithStripe = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (!(await canPayExpense(req, expense))) {
    throw new Forbidden("You don't have permission to pay this expense");
  }

  return await expense.update({ lastEditedById: req.remoteUser?.id });
};

export const declineInvitedExpense = async (
  req: express.Request,
  expense: Expense,
  draftKey?: string,
  message?: string,
): Promise<Expense> => {
  if (expense.status === 'INVITE_DECLINED') {
    return expense;
  }

  if (!(await buildCanDeclineExpenseInviteEvaluator(draftKey)(req, expense))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'INVITE_DECLINED', lastEditedById: req.remoteUser?.id });
  await expense.createActivity(
    activities.COLLECTIVE_EXPENSE_INVITE_DECLINED,
    req.remoteUser,
    message ? { message } : null,
  );

  return updatedExpense;
};

export const markExpenseAsSpam = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (expense.status === 'SPAM') {
    return expense;
  } else if (!(await canMarkAsSpam(req, expense, { throw: true }))) {
    throw new Forbidden();
  }

  const updatedExpense = await expense.update({ status: 'SPAM', lastEditedById: req.remoteUser.id });

  // Limit the user so they can't submit expenses in the future
  const submittedByUser = await updatedExpense.getSubmitterUser();
  await submittedByUser.limitFeature(FEATURE.USE_EXPENSES, `Expense #${expense.id} marked as SPAM`);

  // Cancel recurring expense
  const recurringExpense = await expense.getRecurringExpense();
  if (recurringExpense) {
    await recurringExpense.destroy();
  }

  // We create the activity as a good practice but there is no email sent right now
  const activity = await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_SPAM, req.remoteUser);

  // For now, we send the Slack notification directly from here as there is no framework in activities/notifications
  notifyTeamAboutSpamExpense(activity);

  return updatedExpense;
};

const ROLLING_LIMIT_CACHE_VALIDITY = 3600; // 1h in secs for cache to expire

async function validateExpensePayout2FALimit(req, host, expense, expensePaidAmountKey) {
  const hostPayoutTwoFactorAuthenticationRollingLimit = get(
    host,
    'settings.payoutsTwoFactorAuth.rollingLimit',
    1000000,
  );

  const twoFactorSession =
    req.jwtPayload?.sessionId || (req.personalToken?.id && `personalToken_${req.personalToken.id}`);

  const currentPaidExpenseAmountCache = await cache.get(expensePaidAmountKey);
  const currentPaidExpenseAmount = currentPaidExpenseAmountCache || 0;
  const expenseAmountInHostCurrency = await convertToCurrency(expense.amount, expense.currency, host.currency);

  // requires a 2FA token to be present if there is no value in the cache (first payout by user)
  // or the this payout would put the user over the rolling limit.
  const use2FAToken =
    isNil(currentPaidExpenseAmountCache) ||
    currentPaidExpenseAmount + expenseAmountInHostCurrency > hostPayoutTwoFactorAuthenticationRollingLimit;

  if (!(await twoFactorAuthLib.userHasTwoFactorAuthEnabled(req.remoteUser))) {
    throw new Error('Host has two-factor authentication enabled for large payouts.');
  }

  await twoFactorAuthLib.validateRequest(req, {
    requireTwoFactorAuthEnabled: true, // requires user to have 2FA configured
    alwaysAskForToken: use2FAToken,
    sessionDuration: ROLLING_LIMIT_CACHE_VALIDITY, // duration of a auth session after a token is presented
    sessionKey: `2fa_expense_payout_${host.id}_${twoFactorSession}`, // key of the 2fa session where the 2fa will be valid for the duration
    FromCollectiveId: host.id,
    customData: {
      rollingLimit: {
        expenseAmount: expense.amount,
        expenseCurrency: expense.currency,
        expenseAmountInHostCurrency,
        currentPaidExpenseAmount,
        hostPayoutTwoFactorAuthenticationRollingLimit,
      },
    },
  });

  if (use2FAToken) {
    // if a 2fa token was used, reset rolling limit
    cache.set(expensePaidAmountKey, 0, ROLLING_LIMIT_CACHE_VALIDITY);
  } else {
    cache.set(
      expensePaidAmountKey,
      currentPaidExpenseAmount + expenseAmountInHostCurrency,
      ROLLING_LIMIT_CACHE_VALIDITY,
    );
  }
}

export const validateExpenseCustomData = (value: Record<string, unknown> | null): void => {
  if (!value) {
    return;
  }

  // Validate type: must be a JSON object
  if (typeof value !== 'object') {
    throw new ValidationFailed('Expense custom data must be an object');
  }

  // Validate size
  const payloadSize = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (payloadSize > 10e3) {
    throw new ValidationFailed(`Expense custom data cannot exceed 10kB. Current size: ${payloadSize / 1000}kB`);
  }
};

export const scheduleExpenseForPayment = async (
  req: express.Request,
  expense: Expense,
  options: { feesPayer?: 'COLLECTIVE' | 'PAYEE'; transferDetails?: CreateTransfer['details'] } = {},
): Promise<Expense> => {
  if (expense.status === 'SCHEDULED_FOR_PAYMENT') {
    throw new BadRequest('Expense is already scheduled for payment');
  } else if (!(await canPayExpense(req, expense))) {
    throw new Forbidden("You're authenticated but you can't schedule this expense for payment");
  }

  const host = expense.collective.host || (await expense.collective.getHostCollective({ loaders: req.loaders }));
  if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
    throw new Forbidden('Multi-currency expenses are not enabled for this collective');
  }

  // Update the feesPayer right away because the rest of the process (i.e create transactions) depends on this
  if (options.feesPayer && options.feesPayer !== expense.feesPayer) {
    await expense.update({ feesPayer: options.feesPayer });
  }

  expense.PayoutMethod = await req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId);
  await checkHasBalanceToPayExpense(host, expense, expense.PayoutMethod);
  if (expense.PayoutMethod.type === PayoutMethodTypes.PAYPAL) {
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);

    if (hostHasPayoutTwoFactorAuthenticationEnabled) {
      const expensePaidAmountKey = `${req.remoteUser.id}_2fa_payment_limit`;
      await validateExpensePayout2FALimit(req, host, expense, expensePaidAmountKey);
    }
  }

  // If Wise, add expense to a new batch group
  if (expense.PayoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.scheduleExpenseForPayment(expense, options.transferDetails, req.remoteUser);
  }
  // If PayPal, check if host is connected to PayPal
  else if (expense.PayoutMethod.type === PayoutMethodTypes.PAYPAL) {
    await host.getAccountForPaymentProvider(Service.PAYPAL);
  }

  const updatedExpense = await expense.update({
    status: 'SCHEDULED_FOR_PAYMENT',
    lastEditedById: req.remoteUser.id,
  });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT, req.remoteUser);
  return updatedExpense;
};

export const unscheduleExpensePayment = async (req: express.Request, expense: Expense): Promise<Expense> => {
  if (!(await canUnschedulePayment(req, expense))) {
    throw new BadRequest("Expense is not scheduled for payment or you don't have authorization to unschedule it");
  }

  // If Wise, add expense to a new batch group
  const payoutMethod = await expense.getPayoutMethod();
  if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
    await paymentProviders.transferwise.unscheduleExpenseForPayment(expense);
  }

  const updatedExpense = await expense.update({
    status: 'APPROVED',
    lastEditedById: req.remoteUser.id,
  });

  await expense.createActivity(activities.COLLECTIVE_EXPENSE_UNSCHEDULED_FOR_PAYMENT, req.remoteUser);

  return updatedExpense;
};

/** Check expense's items values, throw if something's wrong */
const checkExpenseItems = (expenseType, items: ExpenseItem[] | Record<string, unknown>[], taxes) => {
  // Check the number of items
  if (!items || items.length === 0) {
    throw new ValidationFailed('Your expense needs to have at least one item');
  } else if (items.length > 300) {
    throw new ValidationFailed('Expenses cannot have more than 300 items');
  }

  // Check amounts
  items.forEach((item, idx) => {
    if (isNil(item.amount)) {
      throw new ValidationFailed(
        `Amount not set for item ${item.description ? `"${item.description}"` : `number ${idx}`}`,
      );
    }
  });

  const sumItems = models.Expense.computeTotalAmountForExpense(items, taxes);
  if (!sumItems) {
    throw new ValidationFailed(`The sum of all items must be above 0`);
  }

  // If expense is a receipt (not an invoice) then files must be attached
  if (expenseType === ExpenseType.RECEIPT) {
    if (items.some(a => !a.url)) {
      throw new ValidationFailed('Some items are missing a file');
    }
  } else if (expenseType === ExpenseType.INVOICE) {
    if (items.some(a => a.url)) {
      throw new ValidationFailed(
        'Invoice items cannot have a file attached. To attach documentation. please use `attachedFiles` on the expense instead.',
      );
    }
  }
};

const checkExpenseType = (
  newType: ExpenseType,
  fromAccount: Collective,
  account: Collective,
  parent: Collective | null,
  host: Collective | null,
  existingExpense: Expense | null = null,
  remoteUser: User | null = null,
): void => {
  // Prevent changing the type in certain cases
  if (existingExpense && newType && existingExpense.type !== newType) {
    if (existingExpense.type === ExpenseType.CHARGE) {
      throw new ValidationFailed('Cannot change the type for this expense');
    } else if (newType === ExpenseType.CHARGE) {
      throw new ValidationFailed('Cannot manually change the type of an expense to "Charge"');
    } else if (newType === ExpenseType.SETTLEMENT) {
      throw new ValidationFailed('Cannot manually change the type of an expense to "Settlement"');
    }
  }

  // Settlements are only allowed for platform admins
  if (!existingExpense && newType === ExpenseType.SETTLEMENT) {
    if (!remoteUser?.isAdminOfPlatform()) {
      throw new ValidationFailed('Only platform admins can create settlements');
    } else if (fromAccount.id !== PlatformConstants.PlatformCollectiveId) {
      throw new ValidationFailed('Settlements can only be created for the platform account');
    }
  }

  // Check flag in settings in the priority order of collective > parent > host
  const accounts = { account, parent, host };
  for (const level of ['account', 'parent', 'host']) {
    const account = accounts[level];
    const value = account?.settings?.expenseTypes?.[newType];
    if (isBoolean(value)) {
      if (value) {
        return; // Flag is explicitly set to true, we're good
      } else {
        throw new ValidationFailed(`Expenses of type ${newType.toLowerCase()} are not allowed by the ${level}`);
      }
    }
  }

  // Only allow virtual card charges to be manually created by host admins
  if (!existingExpense && newType === ExpenseType.CHARGE && !remoteUser?.isAdmin(host?.id)) {
    throw new ValidationFailed('Only host admins can manually create virtual card charges');
  }

  // Fallback on default values
  if (newType === ExpenseType.GRANT) {
    // TODO: enforce this to resolve https://github.com/opencollective/opencollective/issues/5395
  }
};

export const getPayoutMethodFromExpenseData = async (expenseData, remoteUser, fromCollective, dbTransaction?) => {
  if (expenseData.payoutMethod) {
    if (expenseData.payoutMethod.id) {
      const pm = await models.PayoutMethod.findByPk(expenseData.payoutMethod.id);
      if (!pm) {
        throw new Error('This payout method does not exist.');
      }
      // Special case: Payout Method from the Host for "Expense Accross Hosts"
      // No need for extra checks
      if (
        pm.CollectiveId === fromCollective.HostCollectiveId &&
        [PayoutMethodTypes.BANK_ACCOUNT, PayoutMethodTypes.PAYPAL].includes(pm.type)
      ) {
        return pm;
      }
      if (!remoteUser.isAdmin(pm.CollectiveId)) {
        throw new Error("You don't have the permission to use this payout method.");
      }
      if (pm.CollectiveId !== fromCollective.id) {
        throw new Error('This payout method cannot be used for this collective');
      }
      return pm;
    } else {
      return models.PayoutMethod.getOrCreateFromData(
        expenseData.payoutMethod,
        remoteUser,
        fromCollective,
        dbTransaction,
      );
    }
  } else {
    return null;
  }
};

/** Creates attached files for the given expense */
const createAttachedFiles = async (expense, attachedFilesData, remoteUser, transaction) => {
  if (size(attachedFilesData) > 0) {
    return Promise.all(
      attachedFilesData.map(attachedFile => {
        return models.ExpenseAttachedFile.createFromData(attachedFile, remoteUser, expense, transaction);
      }),
    );
  } else {
    return [];
  }
};

export const hasMultiCurrency = (collective, host): boolean => {
  return collective.currency === host?.currency; // Only support multi-currency when collective/host have the same currency
};

type ExpenseData = {
  id?: number;
  payoutMethod?: Record<string, unknown>;
  payeeLocation?: Location;
  items?: { url?: string; amount?: number; amountV2?: AmountInputType; description?: string; incurredAt?: Date }[];
  attachedFiles?: (Record<string, unknown> & { url: string })[];
  invoiceFile?: { url: string };
  collective?: Collective;
  fromCollective?: Collective;
  tags?: string[];
  incurredAt?: Date;
  type?: ExpenseType;
  description?: string;
  privateMessage?: string;
  invoiceInfo?: string;
  longDescription?: string;
  amount?: number;
  currency?: SupportedCurrency;
  tax?: ExpenseTaxDefinition[];
  customData: Record<string, unknown>;
  accountingCategory?: AccountingCategory;
  transactionsImportRow?: TransactionsImportRow;
  reference?: string;
  isNewExpenseFlow?: boolean;
};

const EXPENSE_EDITABLE_FIELDS = [
  'currency',
  'description',
  'longDescription',
  'type',
  'tags',
  'privateMessage',
  'invoiceInfo',
  'payeeLocation',
  'reference',
] as const;

type ExpenseEditableFieldsUnion = (typeof EXPENSE_EDITABLE_FIELDS)[number];

const EXPENSE_PAID_CHARGE_EDITABLE_FIELDS = ['description', 'tags', 'privateMessage', 'invoiceInfo'];

const checkTaxes = (account, host, expenseType: string, taxes): void => {
  if (!taxes?.length) {
    return;
  } else if (taxes.length > 1) {
    throw new ValidationFailed('Only one tax is allowed per expense');
  } else if (expenseType !== ExpenseType.INVOICE) {
    throw new ValidationFailed('Only invoices can have taxes');
  } else {
    return taxes.forEach(({ type, rate }) => {
      if (rate < 0 || rate > 1) {
        throw new ValidationFailed(`Tax rate for ${type} must be between 0% and 100%`);
      } else if (type === LibTaxes.TaxType.VAT && !LibTaxes.accountHasVAT(account, host)) {
        throw new ValidationFailed(`This account does not have VAT enabled`);
      } else if (type === LibTaxes.TaxType.GST && !LibTaxes.accountHasGST(host)) {
        throw new ValidationFailed(`This host does not have GST enabled`);
      }
    });
  }
};

/**
 * Throws if the accounting category is not allowed for this expense/host
 */
const checkCanUseAccountingCategory = (
  remoteUser: User | null,
  expenseType: ExpenseType,
  accountingCategory: AccountingCategory | undefined | null,
  host: Collective | undefined,
  account: Collective,
): void => {
  if (!host) {
    throw new ValidationFailed('Cannot use accounting categories without a host');
  } else if (!accountingCategory) {
    return;
  } else if (accountingCategory.CollectiveId !== host.id) {
    throw new ValidationFailed('This accounting category is not allowed for this host');
  } else if (accountingCategory.kind && accountingCategory.kind !== 'EXPENSE') {
    throw new ValidationFailed('This accounting category is not allowed for expenses');
  } else if (!accountingCategory.isCompatibleWithExpenseType(expenseType)) {
    throw new ValidationFailed(`This accounting category is not allowed for expense type: ${expenseType}`);
  } else if (accountingCategory.hostOnly && !remoteUser?.isAdmin(host.id)) {
    throw new ValidationFailed('This accounting category can only be used by the host admin');
  } else if (
    host.type === CollectiveType.COLLECTIVE && // Independent Collective
    accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOSTED_COLLECTIVES
  ) {
    throw new ValidationFailed(`This accounting category is not applicable to this account`);
  } else if (
    (accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOST &&
      ![account.id, account.ParentCollectiveId].includes(host.id)) ||
    (accountingCategory.appliesTo === AccountingCategoryAppliesTo.HOSTED_COLLECTIVES &&
      [account.id, account.ParentCollectiveId].includes(host.id))
  ) {
    throw new ValidationFailed(`This accounting category is not applicable to this account`);
  }
};

export async function prepareAttachedFiles(req: express.Request, attachedFiles: ExpenseData['attachedFiles']) {
  if (!attachedFiles) {
    return null;
  } else if (!attachedFiles.length) {
    return [];
  }

  const mapItemUrlToUploadedFile: Record<string, string> = {};
  for (const item of attachedFiles) {
    if (!item.url) {
      continue;
    }

    if (!UploadedFile.isUploadedFileURL(item.url)) {
      mapItemUrlToUploadedFile[item.url] = item.url;
      continue;
    }

    if (!(await hasProtectedUrlPermission(req, item.url))) {
      throw new ValidationFailed('Invalid expense attached file url');
    }

    const uploadedFile = await UploadedFile.getFromURL(item.url);

    mapItemUrlToUploadedFile[item.url] = uploadedFile.getDataValue('url');
  }

  return attachedFiles.map(file => ({
    ...file,
    url: mapItemUrlToUploadedFile[file.url],
  }));
}

export async function prepareInvoiceFile(
  req: express.Request,
  invoiceFile: ExpenseData['invoiceFile'],
): Promise<UploadedFile> {
  if (!invoiceFile) {
    return null;
  }

  if (!UploadedFile.isUploadedFileURL(invoiceFile.url)) {
    throw new ValidationFailed('Invalid expense invoice file url');
  }

  if (!(await hasProtectedUrlPermission(req, invoiceFile.url))) {
    throw new ValidationFailed('Invalid expense invoice file url');
  }

  return await UploadedFile.getFromURL(invoiceFile.url);
}

export const prepareExpenseItemInputs = async (
  req: express.Request,
  expenseCurrency: SupportedCurrency,
  itemsInput: Array<ExpenseItem | (Record<string, unknown> & { url?: string })>,
  { isEditing = false } = {},
): Promise<Array<Partial<ExpenseItem>>> => {
  if (!itemsInput) {
    return null;
  } else if (!itemsInput.length) {
    return [];
  }

  // Get all FX rates for items
  const getDateKeyForItem = item => {
    const date = getDate(item['amountV2'].exchangeRate?.date || item.incurredAt || item.createdAt);
    if (!date || moment(date).isAfter(moment(), 'day')) {
      return 'latest';
    } else {
      return date;
    }
  };

  let fxRates;
  const itemsThatNeedFXRates = itemsInput.filter(item => item['amountV2']);
  if (itemsThatNeedFXRates.length) {
    fxRates = await loadFxRatesMap(
      itemsThatNeedFXRates.map(item => ({
        fromCurrency: item['amountV2'].currency as SupportedCurrency,
        toCurrency: expenseCurrency as SupportedCurrency,
        date: getDateKeyForItem(item),
      })),
    );
  }

  const mapItemUrlToUploadedFile: Record<string, string> = {};
  for (const item of itemsInput) {
    if (!item.url) {
      continue;
    }

    if (!UploadedFile.isUploadedFileURL(item.url)) {
      mapItemUrlToUploadedFile[item.url] = item.url;
      continue;
    }

    if (!(await hasProtectedUrlPermission(req, item.url))) {
      throw new ValidationFailed('Invalid expense item url');
    }

    const uploadedFile = await UploadedFile.getFromURL(item.url);
    mapItemUrlToUploadedFile[item.url] = uploadedFile.getDataValue('url');
  }

  // Prepare items
  return itemsInput.map((itemInput, index) => {
    const fieldsToPick = [...ExpenseItem.editableFields, ...(isEditing ? ['id'] : [])];
    const values: Partial<ExpenseItem> = pick(itemInput, fieldsToPick);
    values.order = index;

    if (values.url) {
      values.url = mapItemUrlToUploadedFile[values.url];
    }

    if (itemInput['amount'] && itemInput['amountV2']) {
      throw new ValidationFailed('`amount` and `amountV2` are mutually exclusive. Please use `amountV2` only.');
    } else if (itemInput['amountV2']) {
      values.amount = getValueInCentsFromAmountInput(itemInput['amountV2']);
      values.currency = itemInput['amountV2'].currency;
      if (values.currency !== expenseCurrency) {
        const exchangeRate = itemInput['amountV2'].exchangeRate as GraphQLCurrencyExchangeRateInputType;
        if (!exchangeRate) {
          throw new ValidationFailed(
            'An exchange rate is required when the currency of the item is different from the expense currency.',
          );
        }

        values.expenseCurrencyFxRate = exchangeRate.value;
        values.expenseCurrencyFxRateSource = exchangeRate.source;

        // Other FX rate sources (PayPal, Wise) cannot be set by expense submitters
        if (!['USER', 'OPENCOLLECTIVE'].includes(values.expenseCurrencyFxRateSource)) {
          throw new ValidationFailed('Invalid exchange rate source: Must be USER or OPENCOLLECTIVE.');
        } else if (exchangeRate.fromCurrency !== values.currency || exchangeRate.toCurrency !== expenseCurrency) {
          throw new ValidationFailed(
            `Invalid exchange rate: Expected ${values.currency} to ${expenseCurrency} but got ${exchangeRate.fromCurrency} to ${exchangeRate.toCurrency}.`,
          );
        }

        // Get FX rate from our own system (fixer or DB)
        const fxRatePath = [getDateKeyForItem(itemInput), values.currency, expenseCurrency];
        const internalFxRate = get(fxRates, fxRatePath);

        // Add some checks to make sure the FX rate is acceptable
        if (values.expenseCurrencyFxRateSource === 'OPENCOLLECTIVE') {
          if (!internalFxRate) {
            throw new ValidationFailed(
              `No exchange rate found for this currency pair (${
                values.currency
              } to ${expenseCurrency}) for ${getDateKeyForItem(itemInput)}.`,
            );
          } else if (Math.abs(values.expenseCurrencyFxRate - internalFxRate) / internalFxRate > 0.01) {
            throw new ValidationFailed(
              `Invalid exchange rate: Expected ~${internalFxRate} but got ${values.expenseCurrencyFxRate}.`,
            );
          }
        } else if (values.expenseCurrencyFxRateSource === 'USER' && internalFxRate) {
          // Make sure to update `FX_RATE_ERROR_THRESHOLD` in `components/expenses/lib/utils.ts` when changing the value below
          if (Math.abs(values.expenseCurrencyFxRate - internalFxRate) / internalFxRate > 0.1) {
            throw new ValidationFailed(
              `Invalid exchange rate: The value for ${values.currency} to ${expenseCurrency} (${values.expenseCurrencyFxRate}) is too different from the one in our records (${internalFxRate}).`,
            );
          }
        }
      } else {
        values.expenseCurrencyFxRate = 1;
        values.expenseCurrencyFxRateSource = null;
      }
    } else if (itemInput['amount']) {
      // For backwards compatibility, we force expense currency if not provided
      values.amount = itemInput['amount'] as number;
      values.currency = expenseCurrency;
      values.expenseCurrencyFxRate = 1;
      values.expenseCurrencyFxRateSource = null;
    }

    return values;
  });
};

/**
 * Returns the value to store in `Expense.data.valuesByRole` for the given user.
 */
const getUserRole = (user: User, collective: Collective): keyof ExpenseDataValuesByRole => {
  return user.isAdmin(collective.HostCollectiveId)
    ? ExpenseRoles.hostAdmin
    : user.isAdminOfCollective(collective)
      ? ExpenseRoles.collectiveAdmin
      : ExpenseRoles.submitter;
};

const tryToPredictExpenseCategory = async (collective, expenseData, req): Promise<AccountingCategory | null> => {
  try {
    const predictions = await fetchExpenseCategoryPredictions({
      hostSlug: collective.host.slug,
      accountSlug: collective.slug,
      type: expenseData.type,
      description: expenseData.description,
      items: expenseData.items,
    });

    for (const prediction of predictions) {
      if (prediction.confidence >= 0.1) {
        const predictedCategory = await models.AccountingCategory.findOne({
          where: { CollectiveId: collective.HostCollectiveId, code: prediction.code },
        });

        try {
          checkCanUseAccountingCategory(
            req.remoteUser,
            expenseData.type,
            predictedCategory,
            collective.host,
            collective,
          );
          return predictedCategory;
        } catch {
          continue;
        }
      }
    }
  } catch (e) {
    reportErrorToSentry(e, { req, user: req.remoteUser, feature: FEATURE.USE_EXPENSES, extra: { expenseData } });
  }
};

export async function createExpense(
  req: express.Request,
  expenseData: ExpenseData,
  opts?: { isNewExpenseFlow?: boolean },
): Promise<Expense> {
  const { remoteUser } = req;

  // Check permissions
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to create an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const collective = await models.Collective.findByPk(expenseData.collective.id, {
    include: [
      { association: 'host', required: false },
      { association: 'parent', required: false },
    ],
  });
  if (!collective) {
    throw new ValidationFailed('Collective not found');
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || (await remoteUser.getCollective());
  if (!fromCollective) {
    throw new ValidationFailed('Payee not found');
  }

  // If the collective has public expense submission disabled, only members can create expenses
  const isMember = Boolean(remoteUser.rolesByCollectiveId[String(collective.id)]);
  if (
    collective.settings?.['disablePublicExpenseSubmission'] &&
    !isMember &&
    !remoteUser.isAdminOfCollectiveOrHost(collective) &&
    !remoteUser.isRoot()
  ) {
    throw new Error('You must be a member of the collective to create new expense');
  }

  // Let submitter customize the currency
  let expenseCurrency = collective.currency;
  if (expenseData.currency && expenseData.currency !== expenseCurrency) {
    if (!hasMultiCurrency(collective, collective.host)) {
      throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
    } else {
      expenseCurrency = expenseData.currency;
    }
  }

  const itemsData: Partial<ExpenseItem>[] = await prepareExpenseItemInputs(req, expenseCurrency, expenseData.items);
  const taxes = expenseData.tax || [];

  checkTaxes(collective, collective.host, expenseData.type, taxes);
  checkExpenseItems(expenseData.type, itemsData, taxes);
  checkExpenseType(expenseData.type, fromCollective, collective, collective.parent, collective.host, null, remoteUser);

  let accountingCategorySource: 'submitter' | 'prediction' = 'submitter';
  if (expenseData.accountingCategory) {
    checkCanUseAccountingCategory(
      remoteUser,
      expenseData.type,
      expenseData.accountingCategory,
      collective.host,
      collective,
    );
  } else if (collective.host?.settings?.autoAssignExpenseCategoryPredictions) {
    expenseData.accountingCategory = await tryToPredictExpenseCategory(collective, expenseData, req);
    accountingCategorySource = 'prediction';
  }

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  const isAllowedType = [
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ].includes(collective.type);
  const isActiveHost = collective.type === CollectiveType.ORGANIZATION && collective.isActive;
  if (!isAllowedType && !isActiveHost) {
    throw new ValidationFailed(
      'Expenses can only be submitted to Collectives, Events, Funds, Projects and active Hosts.',
    );
  }

  // Check payee
  if (fromCollective.type === CollectiveType.VENDOR) {
    const host = await collective.getHostCollective();
    assert(
      fromCollective.ParentCollectiveId === collective.HostCollectiveId,
      new ValidationFailed('Vendor must belong to the same Fiscal Host as the Collective'),
    );
    const publicVendorPolicy = await getPolicy(host, POLICIES.EXPENSE_PUBLIC_VENDORS);
    assert(
      publicVendorPolicy || remoteUser.isAdminOfCollective(fromCollective),
      new ValidationFailed('User cannot submit expenses on behalf of this vendor'),
    );
  } else if (!remoteUser.isAdminOfCollective(fromCollective)) {
    throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
  } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
    throw new ValidationFailed('This account cannot be used for payouts');
  }

  // Update payee's location
  const existingLocation = await fromCollective.getLocation();
  if (!(expenseData.payeeLocation?.address || expenseData.payeeLocation?.structured) && existingLocation) {
    expenseData.payeeLocation = pick(existingLocation, ['address', 'country', 'structured']);
  } else if (
    (expenseData.payeeLocation?.address || expenseData.payeeLocation?.structured) &&
    (!existingLocation?.address || !existingLocation?.structured)
  ) {
    await fromCollective.setLocation(expenseData.payeeLocation);

    // Create formatted address if it does not exist
    const address =
      expenseData.payeeLocation?.address || (await formatAddress(expenseData.payeeLocation, { lineDivider: '\n' }));

    expenseData.payeeLocation = {
      address,
      ...expenseData.payeeLocation,
    };
  }

  // Get or create payout method
  const payoutMethod =
    fromCollective.type === CollectiveType.VENDOR
      ? await fromCollective.getPayoutMethods({ where: { isSaved: true } }).then(first)
      : await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, null);

  if (payoutMethod?.type === PayoutMethodTypes.STRIPE && expenseData.type !== ExpenseType.SETTLEMENT) {
    throw new ValidationFailed('Stripe payout method can only be used with settlement expenses.');
  }

  // Create and validate TransferWise recipient
  let recipient;
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>expenseData.fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }

    const connectedAccount =
      collective.host &&
      (await collective.host.getAccountForPaymentProvider(Service.TRANSFERWISE, { throwIfMissing: false }));
    if (connectedAccount) {
      paymentProviders.transferwise.validatePayoutMethod(connectedAccount, payoutMethod);
      recipient = await paymentProviders.transferwise.createRecipient(connectedAccount, payoutMethod);
    }
  }

  // Check Transactions import
  if (expenseData.transactionsImportRow) {
    if (!collective.host) {
      throw new ValidationFailed('The collective must have a host to import expenses');
    } else if (!remoteUser.isAdminOfCollective(collective.host)) {
      throw new Forbidden('You need to be an admin of the collective to import expenses');
    } else if (expenseData.transactionsImportRow.isProcessed()) {
      throw new ValidationFailed('This transaction has already been processed');
    }

    const transactionsImport = await expenseData.transactionsImportRow.getImport();
    if (!transactionsImport) {
      throw new NotFound('TransactionsImport not found');
    } else if (transactionsImport.CollectiveId !== collective.host.id) {
      throw new ValidationFailed('This import does not belong to the host');
    }
  }

  // Expense data
  const data = { recipient, taxes };
  if (expenseData.customData) {
    validateExpenseCustomData(expenseData.customData);
    data['customData'] = expenseData.customData;
  }
  if (expenseData.accountingCategory) {
    const key = accountingCategorySource === 'submitter' ? getUserRole(remoteUser, collective) : 'prediction';
    data['valuesByRole'] = {
      [key]: { accountingCategory: expenseData.accountingCategory.publicInfo },
    };
  }

  if (opts?.isNewExpenseFlow) {
    data['isNewExpenseFlow'] = true;
  }

  const expense = await sequelize.transaction(async t => {
    let invoiceFileId: number;
    if (expenseData.type === ExpenseType.INVOICE && expenseData.invoiceFile) {
      const invoiceFile = await prepareInvoiceFile(req, expenseData.invoiceFile);
      invoiceFileId = invoiceFile.id;
    }

    // Create expense
    const createdExpense = await models.Expense.create(
      {
        ...(<Pick<ExpenseData, ExpenseEditableFieldsUnion>>pick(expenseData, EXPENSE_EDITABLE_FIELDS)),
        currency: expenseCurrency,
        tags: expenseData.tags,
        status: ExpenseStatus.PENDING,
        CollectiveId: collective.id,
        FromCollectiveId: fromCollective.id,
        lastEditedById: remoteUser.id,
        UserId: remoteUser.id,
        incurredAt: expenseData.incurredAt || min(itemsData.map(item => item.incurredAt)) || new Date(),
        PayoutMethodId: payoutMethod && payoutMethod.id,
        legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
        amount: models.Expense.computeTotalAmountForExpense(itemsData, taxes),
        AccountingCategoryId: expenseData.accountingCategory?.id,
        InvoiceFileId: invoiceFileId,
        data,
      },
      { transaction: t },
    );

    // Create items
    createdExpense.items = await Promise.all(
      itemsData.map(itemData => {
        return models.ExpenseItem.createFromData(itemData, remoteUser, createdExpense, t);
      }),
    );

    // Create attached files
    const attachedFiles = await prepareAttachedFiles(req, expenseData.attachedFiles);
    createdExpense.attachedFiles = await createAttachedFiles(createdExpense, attachedFiles, remoteUser, t);

    // Link to transactions import
    if (expenseData.transactionsImportRow) {
      await expenseData.transactionsImportRow.update(
        { ExpenseId: createdExpense.id, status: 'LINKED' },
        { transaction: t },
      );
    }

    return createdExpense;
  });

  expense.user = remoteUser;
  expense.collective = collective;
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_CREATED, remoteUser);

  if (expenseData.transactionsImportRow) {
    await createTransactionsForManuallyPaidExpense(collective.host, expense, 0, expense.amount, null);
    await expense.markAsPaid({ user: remoteUser, isManualPayout: true });
  }

  try {
    await expense.updateTaxFormStatus(collective.host, fromCollective, remoteUser, { UserTokenId: req.userToken?.id });
  } catch (e) {
    // We don't want to block the expense creation if the tax form fails
    reportErrorToSentry(e, { req, user: remoteUser, feature: FEATURE.USE_EXPENSES, extra: { expense } });
  }

  return expense;
}

/** Returns true if the expense should by put back to PENDING after this update */
export const changesRequireStatusUpdate = (
  expense: Expense,
  newExpenseData: ExpenseData,
  hasItemsChanges: boolean,
  hasPayoutChanges = false,
): boolean => {
  const updatedValues = { ...expense.dataValues, ...newExpenseData };
  const hasAmountChanges = typeof updatedValues.amount !== 'undefined' && updatedValues.amount !== expense.amount;
  const isPaidOrProcessingCharge =
    expense.type === ExpenseType.CHARGE && ['PAID', 'PROCESSING'].includes(expense.status);

  if (isPaidOrProcessingCharge && !hasAmountChanges) {
    return false;
  }
  return hasItemsChanges || hasAmountChanges || hasPayoutChanges;
};

/** Returns infos about the changes made to items */
export const getItemsChanges = async (
  existingItems: ExpenseItem[],
  items: ExpenseData['items'],
): Promise<[boolean, [Record<string, unknown>[], ExpenseItem[], Record<string, unknown>[]]]> => {
  if (items) {
    const itemsDiff = models.ExpenseItem.diffDBEntries(existingItems, items);
    const hasItemChanges = flatten(<unknown[]>itemsDiff).length > 0;
    return [hasItemChanges, itemsDiff];
  } else {
    return [false, [[], [], []]];
  }
};

/*
 * Validate the account holder name against the legal name. Following cases are considered a match,
 *
 * 1) Punctuation are ignored; "Evil Corp, Inc" and "Evil Corp, Inc." are considered a match.
 * 2) Accents are ignored; "François" and "Francois" are considered a match.
 * 3) The first name and last name order is ignored; "Benjamin Piouffle" and "Piouffle Benjamin" is considered a match.
 * 4) If one of account holder name or legal name is not defined then this function returns true.
 */
export const isAccountHolderNameAndLegalNameMatch = (accountHolderName: string, legalName: string): boolean => {
  // Ignore 501(c)(3) in both account holder name and legal name
  legalName = legalName.replace(/501\(c\)\(3\)/g, '');
  accountHolderName = accountHolderName.replace(/501\(c\)\(3\)/g, '');

  const namesArray = legalName.trim().split(' ');
  let legalNameReversed;
  if (namesArray.length === 2) {
    const firstName = namesArray[0];
    const lastName = namesArray[1];
    legalNameReversed = `${lastName} ${firstName}`;
  }
  return !(
    accountHolderName.localeCompare(legalName, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    }) &&
    accountHolderName.localeCompare(legalNameReversed, undefined, {
      sensitivity: 'base',
      ignorePunctuation: true,
    })
  );
};

export async function submitExpenseDraft(
  req: express.Request,
  expenseData: ExpenseData,
  {
    args,
    requestedPayee,
    originalPayee,
    isNewExpenseFlow,
  }: {
    args?: Record<string, any> & { draftKey?: string };
    originalPayee?: Collective;
    requestedPayee?: Collective;
    isNewExpenseFlow?: boolean;
  } = {},
) {
  // It is a submit on behalf being completed
  let existingExpense = await models.Expense.findByPk(expenseData.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });

  if (!existingExpense) {
    throw new NotFound('Expense not found.');
  }
  if (existingExpense.status !== ExpenseStatus.DRAFT) {
    throw new Forbidden('Expense can not be edited.');
  }

  const userIsOriginalPayee: boolean = Boolean(originalPayee) && req.remoteUser?.isAdminOfCollective(originalPayee);
  const userIsAuthor = Boolean(req.remoteUser) && req.remoteUser.id === existingExpense.UserId;
  if (existingExpense.data?.draftKey !== args.draftKey && !userIsOriginalPayee && !userIsAuthor) {
    throw new Unauthorized('You need to submit the right draft key to edit this expense');
  }

  await checkLockedFields(existingExpense, { ...expenseData, payee: requestedPayee || args.expense.payee });

  const options = {
    overrideRemoteUser: undefined,
    skipPermissionCheck: true,
    skipActivity: true,
    isNewExpenseFlow: isNewExpenseFlow === true ? true : undefined,
  };
  if (requestedPayee) {
    if (!req.remoteUser?.isAdminOfCollective(requestedPayee)) {
      throw new Forbidden('User needs to be the admin of the payee to submit an expense on their behalf');
    }
  } else {
    const { organization: organizationData, ...payee } = args.expense.payee;
    const { user, organization } = await createUser(
      {
        ...pick(payee, ['email', 'name', 'legalName', 'newsletterOptIn']),
        location: expenseData.payeeLocation,
      },
      {
        organizationData,
        throwIfExists: true,
        sendSignInLink: true,
        redirect: `/${existingExpense.collective.slug}/expenses/${expenseData.id}`,
        creationRequest: {
          ip: req.ip,
          userAgent: req.header?.['user-agent'],
        },
      },
    );
    expenseData.fromCollective = organization || user.collective;
    options.overrideRemoteUser = user;
    options.skipPermissionCheck = true;
  }

  let status = undefined;
  if (
    options.overrideRemoteUser &&
    existingExpense.data?.draftKey === args.draftKey &&
    existingExpense.data?.payee?.email === options.overrideRemoteUser.email
  ) {
    status = ExpenseStatus.PENDING;
  } else if (options.overrideRemoteUser?.id) {
    status = ExpenseStatus.UNVERIFIED;
  }

  existingExpense = await editExpense(req, expenseData, options);

  await existingExpense.update({
    status,
    lastEditedById: options.overrideRemoteUser?.id || req.remoteUser?.id,
    UserId: options.overrideRemoteUser?.id || req.remoteUser?.id,
  });

  await existingExpense.createActivity(
    activities.COLLECTIVE_EXPENSE_CREATED,
    options.overrideRemoteUser ?? req.remoteUser,
  );

  return existingExpense;
}

export const DRAFT_EXPENSE_FIELDS = [
  'description',
  'longDescription',
  'tags',
  'type',
  'privateMessage',
  'invoiceInfo',
  'reference',
] as const;

/**
 * Returns true if the value has changed.
 *
 * /!\ We have no 1-to-1 field mapping between `Expense` and `ExpenseData`, but since we used to only
 * check `isNil` this won't introduce any regression. Ideally, this helper should do a mapping between the two.
 */
const isValueChanging = (expense: Expense, expenseData: Partial<ExpenseData>, key: string): boolean => {
  const value = expenseData[key];
  if (key === 'accountingCategory') {
    return !isUndefined(value) && (value?.id ?? null) !== expense.AccountingCategoryId;
  } else if (key === 'invoiceFile') {
    return !isUndefined(value) && !isEqual(value, expense[key]);
  } else {
    return !isNil(value) && !isEqual(value, expense[key]);
  }
};

const isDifferentInvitedPayee = (expense: Expense, payee): boolean => {
  const isInvitedPayee = !expense.data?.payee?.id && expense.data.payee.email;
  if (isInvitedPayee) {
    return !matches(expense.data.payee)(payee);
  }
  return false;
};

const checkLockedFields = async (
  existing: Expense,
  updated: ExpenseData & { payee?: Collective | { legacyId: number } | { email: string; name: string } },
): Promise<void> => {
  const lockedFields = existing?.data?.lockedFields;
  if (!lockedFields) {
    return;
  }

  if (lockedFields.includes(ExpenseLockableFields.DESCRIPTION) && isValueChanging(existing, updated, 'description')) {
    throw new Forbidden('Description cannot be edited');
  }

  if (lockedFields.includes(ExpenseLockableFields.TYPE) && isValueChanging(existing, updated, 'type')) {
    throw new Forbidden('Type cannot be edited');
  }

  if (lockedFields.includes(ExpenseLockableFields.PAYEE) && updated.payee) {
    const expectedPayee = existing.data.payee;
    if ('id' in expectedPayee) {
      const updatedId = 'legacyId' in updated.payee ? updated.payee.legacyId : (updated.payee as Collective).id;
      assert(updatedId && expectedPayee.id === updatedId, new Forbidden('Payee cannot be edited'));
    } else if ('email' in expectedPayee) {
      if ('email' in updated.payee) {
        assert(expectedPayee.email === updated.payee.email, new Forbidden('Payee cannot be edited'));
      } else {
        const updatedId = 'legacyId' in updated.payee ? updated.payee.legacyId : updated.payee.id;
        const user = await models.User.findOne({ where: { CollectiveId: updatedId } });
        assert(user && expectedPayee.email === user.email, new Forbidden('Payee cannot be edited'));
      }
    }
  }

  if (lockedFields.includes(ExpenseLockableFields.AMOUNT)) {
    assert(!isValueChanging(existing, updated, 'amount'), new Forbidden('Amount cannot be edited'));
    assert(!isValueChanging(existing, updated, 'currency'), new Forbidden('Currency cannot be edited'));
  }
};

export async function sendDraftExpenseInvite(
  req: express.Request,
  expense: Expense,
  collective: Collective,
  draftKey: string,
): Promise<void> {
  const inviteUrl = `${config.host.website}/${collective.slug}/expenses/${expense.id}?key=${draftKey}`;
  expense
    .createActivity(activities.COLLECTIVE_EXPENSE_INVITE_DRAFTED, req.remoteUser, {
      ...expense.data,
      inviteUrl,
    })
    .catch(e => {
      logger.error('An error happened when creating the COLLECTIVE_EXPENSE_INVITE_DRAFTED activity', e);
      reportErrorToSentry(e);
    });
  if (config.env === 'development') {
    logger.info(`Expense Invite Link: ${inviteUrl}`);
  }
}

export async function editExpenseDraft(
  req: express.Request,
  expenseData: ExpenseData,
  args: Record<string, any>,
  opts?: { isNewExpenseFlow?: boolean },
) {
  const existingExpense = await models.Expense.findByPk(expenseData.id, {
    include: [{ model: models.ExpenseItem, as: 'items' }],
  });
  if (!existingExpense) {
    throw new NotFound('Expense not found.');
  }

  if (existingExpense.status !== ExpenseStatus.DRAFT) {
    throw new Unauthorized('Expense can not be edited.');
  }
  if (!req.remoteUser || req.remoteUser?.id !== existingExpense.UserId) {
    throw new Unauthorized('Only the author of the draft can edit it');
  }

  const currency = expenseData.currency || existingExpense.currency;
  const items =
    (await prepareExpenseItemInputs(req, currency, expenseData.items, { isEditing: true })) || existingExpense.items;

  const attachedFiles = await prepareAttachedFiles(req, expenseData.attachedFiles);
  const invoiceFile =
    (expenseData.type || existingExpense.type) === ExpenseType.INVOICE
      ? await prepareInvoiceFile(req, expenseData.invoiceFile)
      : null;

  const newExpenseValues = {
    ...pick(expenseData, DRAFT_EXPENSE_FIELDS),
    amount: models.Expense.computeTotalAmountForExpense(items, expenseData.tax),
    lastEditedById: req.remoteUser.id,
    UserId: req.remoteUser.id,
    data: {
      items,
      taxes: expenseData.tax,
      attachedFiles: attachedFiles,
      invoiceFile: invoiceFile ? { url: invoiceFile.getDataValue('url') } : null,
    },
  };

  await checkLockedFields(existingExpense, expenseData);

  if (args.expense.payee && isDifferentInvitedPayee(existingExpense, args.expense.payee)) {
    const payee = args.expense.payee as { email: string; name?: string };
    if (payee.email) {
      payee.email = payee.email.toLowerCase();
    }
    newExpenseValues.data['payee'] = payee;
    newExpenseValues.data['draftKey'] =
      process.env.OC_ENV === 'e2e' || process.env.OC_ENV === 'ci' ? 'draft-key' : uuid();
  }

  if (opts?.isNewExpenseFlow) {
    newExpenseValues['isNewExpenseFlow'] = true;
  }

  await existingExpense.update({ ...newExpenseValues, data: { ...existingExpense.data, ...newExpenseValues.data } });
  existingExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, req.remoteUser);

  if (newExpenseValues.data['draftKey']) {
    const collective = await req.loaders.Collective.byId.load(existingExpense.CollectiveId);
    await sendDraftExpenseInvite(req, existingExpense, collective, newExpenseValues.data['draftKey']);
  }

  return existingExpense;
}

/**
 * A simple helper to handle the case when editing only the tags and/or accounting category of an expense.
 * Permissions for these fields (especially regarding the status of the expense) are more relaxed than for other fields.
 */
const editOnlyTagsAndAccountingCategory = async (
  expense: Expense,
  expenseData: Pick<ExpenseData, 'tags' | 'accountingCategory'>,
  req: express.Request,
): Promise<Expense> => {
  const updateClauses = [];

  // Tags
  if (!isUndefined(expenseData.tags)) {
    if (!(await canEditExpenseTags(req, expense))) {
      throw new Forbidden("You don't have permission to edit tags for this expense");
    }

    updateClauses.push(`"tags" = Array[:tags]::VARCHAR(255)[]`);
  }

  // Accounting category
  if (isValueChanging(expense, expenseData, 'accountingCategory')) {
    if (!(await canEditExpenseAccountingCategory(req, expense))) {
      throw new Forbidden("You don't have permission to edit the accounting category for this expense");
    }

    const userRole = getUserRole(req.remoteUser, expense.collective);
    updateClauses.push(`"AccountingCategoryId" = :AccountingCategoryId`);
    updateClauses.push(
      `"data" = ${deepJSONBSet('data', ['valuesByRole', userRole, 'accountingCategory'], ':accountingCategory')}`,
    );
  }

  if (isEmpty(updateClauses)) {
    return expense;
  }

  // Use a raw query to unlock the ability of using `JSONB_SET`, which will prevent concurrency issues on the `data` field
  const updatedExpense = await sequelize.query(
    `UPDATE "Expenses" SET ${updateClauses.join(', ')} WHERE id = :id RETURNING *`,
    {
      model: models.Expense,
      plain: true,
      mapToModel: true,
      replacements: {
        id: expense.id,
        tags: expenseData.tags || [],
        AccountingCategoryId: expenseData.accountingCategory?.id || null,
        accountingCategory: JSON.stringify(expenseData.accountingCategory?.publicInfo || null),
      },
    },
  );

  updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, req.remoteUser);
  return updatedExpense;
};

export async function editExpense(
  req: express.Request,
  expenseData: ExpenseData,
  options: {
    skipActivity?: boolean;
    overrideRemoteUser?: User;
    skipPermissionCheck?: boolean;
    draftKey?: string;
    isNewExpenseFlow?: boolean;
  } = {},
): Promise<Expense> {
  const remoteUser = options?.overrideRemoteUser || req.remoteUser;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to edit an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseData.id, {
    include: [
      {
        model: models.Collective,
        as: 'collective',
        required: true,
        include: [
          { association: 'host', required: false },
          { association: 'parent', required: false },
        ],
      },
      { model: models.Collective, as: 'fromCollective' },
      { model: models.ExpenseAttachedFile, as: 'attachedFiles' },
      { model: models.PayoutMethod },
      { association: 'items' },
      { association: 'accountingCategory' },
      { association: 'host', required: false },
    ],
  });

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  const { collective } = expense;
  const { host } = collective;
  const expenseType = expenseData.type || expense.type;
  const isPaidCreditCardCharge =
    expense.type === ExpenseType.CHARGE &&
    ['PAID', 'PROCESSING'].includes(expense.status) &&
    Boolean(expense.VirtualCardId);

  // Check category only if it's changing
  if (expenseData.accountingCategory) {
    checkCanUseAccountingCategory(
      remoteUser,
      expenseType,
      expenseData.accountingCategory,
      expense.host ?? expense.collective.host,
      expense.collective,
    );
  }

  // Edit directly the expense when touching only tags and/or accounting category. It's ok to do that here,
  // before the `canEditExpense` permissions check, because `editOnlyTagsAndAccountingCategory` has its
  // own permissions checks that are more permissive (e.g. tags can be edited even if the expense is paid)
  const modifiedFields = omitBy(expenseData, (_, key) => key === 'id' || !isValueChanging(expense, expenseData, key));
  if (Object.keys(modifiedFields).every(field => ['tags', 'accountingCategory'].includes(field))) {
    return editOnlyTagsAndAccountingCategory(expense, modifiedFields, req);
  }

  // Check if 2FA is enforced on any of the account remote user is admin of, unless it's a paid credit card charge
  // since we strictly limit the fields that can be updated in that case
  if (req.remoteUser && !isPaidCreditCardCharge) {
    const accountsFor2FA = [expenseData.fromCollective, expense.fromCollective, collective, host].filter(Boolean);
    await twoFactorAuthLib.enforceForAccountsUserIsAdminOf(req, accountsFor2FA);
  }

  // Load the payee profile
  const fromCollective = expenseData.fromCollective || expense.fromCollective;

  // When changing the type, we must make sure that the new type is allowed
  if (expenseData.type && expenseData.type !== expense.type) {
    checkExpenseType(
      expenseData.type,
      fromCollective,
      collective,
      collective.parent,
      collective.host,
      expense,
      remoteUser,
    );
  }

  // Let submitter customize the currency
  const isChangingCurrency = expenseData.currency && expenseData.currency !== expense.currency;
  if (isChangingCurrency && expenseData.currency !== collective.currency && !hasMultiCurrency(collective, host)) {
    throw new FeatureNotSupportedForCollective('Multi-currency expenses are not enabled for this account');
  }

  const expenseCurrency = expenseData.currency || expense.currency;
  const updatedItemsData: Partial<ExpenseItem>[] =
    (await prepareExpenseItemInputs(req, expenseCurrency, expenseData.items, { isEditing: true })) || expense.items;
  const [hasItemChanges, itemsDiff] = await getItemsChanges(expense.items, updatedItemsData);
  const taxes = expenseData.tax || (expense.data?.taxes as ExpenseTaxDefinition[]) || [];
  checkTaxes(expense.collective, expense.collective.host, expenseType, taxes);

  if (!options?.skipPermissionCheck && !(await canEditExpense(req, expense))) {
    throw new Forbidden("You don't have permission to edit this expense");
  }

  if (isPaidCreditCardCharge && !hasItemChanges) {
    throw new ValidationFailed(
      'You need to include Expense Items when adding missing information to card charge expenses',
    );
  }

  if (size(expenseData.attachedFiles) > 15) {
    throw new ValidationFailed('The number of files that you can attach to an expense is limited to 15');
  }

  // Check payee
  if (expenseData.fromCollective && expenseData.fromCollective.id !== expense.fromCollective.id) {
    if (!options?.skipPermissionCheck && !remoteUser.isAdminOfCollective(fromCollective)) {
      throw new ValidationFailed('You must be an admin of the account to submit an expense in its name');
    } else if (!fromCollective.canBeUsedAsPayoutProfile()) {
      throw new ValidationFailed('This account cannot be used for payouts');
    }
    // If payee is a vendor, make sure it belongs to the same Fiscal Host as the collective
    if (fromCollective.type === CollectiveType.VENDOR) {
      assert(
        fromCollective.ParentCollectiveId === collective.HostCollectiveId,
        new ValidationFailed('Vendor must belong to the same Fiscal Host as the Collective'),
      );
    }
  }

  await checkLockedFields(expense, {
    ...expenseData,
    items: updatedItemsData,
    amount: models.Expense.computeTotalAmountForExpense(updatedItemsData, taxes),
    payee: options?.overrideRemoteUser?.collective || expenseData.fromCollective,
  });

  // Let's take the opportunity to update collective's location
  const existingLocation = await fromCollective.getLocation();
  if (
    (expenseData.payeeLocation?.address || expenseData.payeeLocation?.structured) &&
    (!existingLocation?.address || !existingLocation?.structured)
  ) {
    await fromCollective.setLocation(expenseData.payeeLocation);
  }

  const cleanExpenseData = {
    ...(<Pick<ExpenseData, ExpenseEditableFieldsUnion>>(
      pick(expenseData, isPaidCreditCardCharge ? EXPENSE_PAID_CHARGE_EDITABLE_FIELDS : EXPENSE_EDITABLE_FIELDS)
    )),
    data: !expense.data ? null : cloneDeep(omit(expense.data, ['items', 'draftKey', 'recipient', 'quote'])), // Make sure we omit draft key and items
  };

  // Update the accounting category
  if (!isUndefined(modifiedFields['accountingCategory'])) {
    if (!(await canEditExpenseAccountingCategory(req, expense))) {
      throw new Forbidden("You don't have permission to edit the accounting category for this expense");
    } else {
      checkCanUseAccountingCategory(
        remoteUser,
        expenseData.type,
        expenseData.accountingCategory,
        expense.host ?? expense.collective.host,
        expense.collective,
      );
      cleanExpenseData['AccountingCategoryId'] = expenseData.accountingCategory?.id || null;
      const dataValuePath = `data.valuesByRole.${getUserRole(remoteUser, collective)}.accountingCategory`;
      set(cleanExpenseData, dataValuePath, expenseData.accountingCategory?.publicInfo || null);
    }
  }

  let payoutMethod = await expense.getPayoutMethod();
  let feesPayer = expense.feesPayer;
  const previousStatus = expense.status;

  // Validate bank account payout method
  if (payoutMethod?.type === PayoutMethodTypes.BANK_ACCOUNT) {
    if (![ExpenseStatus.PAID, ExpenseStatus.PROCESSING].includes(expense.status as ExpenseStatus)) {
      cleanExpenseData.data = omit(cleanExpenseData.data, ['recipient', 'quote']);
    }
    const payoutMethodData = <BankAccountPayoutMethodData>payoutMethod.data;
    const accountHolderName = payoutMethodData?.accountHolderName;
    const legalName = <string>fromCollective.legalName;
    if (accountHolderName && legalName && !isAccountHolderNameAndLegalNameMatch(accountHolderName, legalName)) {
      logger.warn('The legal name should match the bank account holder name (${accountHolderName} ≠ ${legalName})');
    }
  }

  const updatedExpense = await sequelize.transaction(async transaction => {
    // Update payout method if we get new data from one of the param for it
    if (
      !isPaidCreditCardCharge &&
      expenseData.payoutMethod !== undefined &&
      (!expenseData.payoutMethod?.id || // This represents a new payout method without an id
        expenseData.payoutMethod?.id !== expense.PayoutMethodId)
    ) {
      payoutMethod =
        fromCollective.type === CollectiveType.VENDOR
          ? await fromCollective.getPayoutMethods().then(first)
          : await getPayoutMethodFromExpenseData(expenseData, remoteUser, fromCollective, null);

      if (payoutMethod?.type === PayoutMethodTypes.STRIPE && expenseType !== ExpenseType.SETTLEMENT) {
        throw new ValidationFailed('Stripe payout method can only be used with settlement expenses.');
      }

      // Reset fees payer when changing the payout method and the new one doesn't support it
      if (feesPayer === ExpenseFeesPayer.PAYEE && !models.PayoutMethod.typeSupportsFeesPayer(payoutMethod?.type)) {
        feesPayer = ExpenseFeesPayer.COLLECTIVE;
      }
    }

    // Update items
    if (hasItemChanges) {
      const simulatedItemsUpdate = simulateDBEntriesDiff(expense.items, itemsDiff);
      checkExpenseItems(expenseType, simulatedItemsUpdate, taxes);
      const [newItemsData, itemsToRemove, itemsToUpdate] = itemsDiff;
      await Promise.all(<Promise<void>[]>[
        // Delete
        ...itemsToRemove.map(item => {
          return item.destroy({ transaction });
        }),
        // Create
        ...newItemsData.map(itemData => {
          return models.ExpenseItem.createFromData(
            { ...itemData, currency: itemData.currency || expenseData.currency || expense.currency },
            remoteUser,
            expense,
            transaction,
          );
        }),
        // Update
        ...itemsToUpdate.map(itemData => {
          return models.ExpenseItem.updateFromData(
            { ...itemData, currency: itemData.currency || expenseData.currency || expense.currency },
            transaction,
          );
        }),
      ]);

      // Reload items
      expense.items = await expense.getItems({ transaction, order: [['id', 'ASC']] });
    }

    // Update expense
    // When updating amount, attachment or payoutMethod, we reset its status to PENDING
    const PayoutMethodId = payoutMethod ? payoutMethod.id : null;
    const shouldUpdateStatus = changesRequireStatusUpdate(
      expense,
      expenseData,
      hasItemChanges,
      PayoutMethodId !== expense.PayoutMethodId,
    );

    // Update attached files
    if (expenseData.attachedFiles) {
      const attachedFiles = await prepareAttachedFiles(req, expenseData.attachedFiles);
      const [newAttachedFiles, removedAttachedFiles, updatedAttachedFiles] = models.ExpenseAttachedFile.diffDBEntries(
        expense.attachedFiles,
        attachedFiles,
      );

      await createAttachedFiles(expense, newAttachedFiles, remoteUser, transaction);
      await Promise.all(removedAttachedFiles.map((file: ExpenseAttachedFile) => file.destroy()));
      await Promise.all(
        updatedAttachedFiles.map((file: Record<string, unknown>) =>
          models.ExpenseAttachedFile.update({ url: file.url }, { where: { id: file.id, ExpenseId: expense.id } }),
        ),
      );
    }

    if (!isUndefined(expenseData.invoiceFile) && (expenseData.type || expense.type) === ExpenseType.INVOICE) {
      const newInvoiceUploadedFile = expenseData.invoiceFile
        ? await prepareInvoiceFile(req, expenseData.invoiceFile)
        : null;

      if (expense.InvoiceFileId && (!newInvoiceUploadedFile || expense.InvoiceFileId !== newInvoiceUploadedFile.id)) {
        const oldInvoiceUploadedFile = await UploadedFile.findByPk(expense.InvoiceFileId, { transaction });
        await oldInvoiceUploadedFile.destroy({ transaction });
        cleanExpenseData['InvoiceFileId'] = null;
      }

      if (newInvoiceUploadedFile) {
        cleanExpenseData['InvoiceFileId'] = newInvoiceUploadedFile.id;
      }
    }

    let status = expense.status;
    if (status === 'INCOMPLETE') {
      // When dealing with expenses marked as INCOMPLETE, only return to PENDING if the expense change requires Collective review
      status = changesRequireStatusUpdate(expense, expenseData, hasItemChanges) ? 'PENDING' : 'APPROVED';
    } else if (shouldUpdateStatus) {
      status = 'PENDING';
    }

    const updatedExpenseProps = {
      ...cleanExpenseData,
      amount: models.Expense.computeTotalAmountForExpense(expense.items, taxes), // We've reloaded the items above
      lastEditedById: remoteUser.id,
      incurredAt: expenseData.incurredAt || min(expense.items.map(item => item.incurredAt)) || new Date(),
      status,
      FromCollectiveId: fromCollective.id,
      PayoutMethodId: PayoutMethodId,
      legacyPayoutMethod: models.Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      tags: cleanExpenseData.tags,
    };

    if (isPaidCreditCardCharge) {
      set(updatedExpenseProps, 'data.missingDetails', false);
    }
    if (!isEqual(expense.data?.taxes, taxes)) {
      set(updatedExpenseProps, 'data.taxes', taxes);
    }
    if (!isUndefined(expenseData.customData) && !isEqual(expense.data?.customData, expenseData.customData)) {
      validateExpenseCustomData(expenseData.customData);
      set(updatedExpenseProps, 'data.customData', expenseData.customData);
    }

    return expense.update(updatedExpenseProps, { transaction });
  });

  if (isPaidCreditCardCharge) {
    if (cleanExpenseData.description) {
      await models.Transaction.update(
        { description: cleanExpenseData.description },
        { where: { ExpenseId: updatedExpense.id } },
      );
    }

    // Auto Resume Virtual Card
    if (host?.settings?.virtualcards?.autopause) {
      const virtualCard = await expense.getVirtualCard();
      const expensesMissingReceipts = await virtualCard.getExpensesMissingDetails();
      if (virtualCard.isPaused() && expensesMissingReceipts.length === 0) {
        await virtualCard.resume();
      }
    }
  }

  if (!options?.skipActivity) {
    const notifyCollective = previousStatus === 'INCOMPLETE' && updatedExpense.status === 'PENDING';
    await updatedExpense.createActivity(activities.COLLECTIVE_EXPENSE_UPDATED, remoteUser, { notifyCollective });
  }

  try {
    await expense.updateTaxFormStatus(host, fromCollective, remoteUser, { UserTokenId: req.userToken?.id });
  } catch (e) {
    // We don't want to block the expense creation if the tax form fails
    reportErrorToSentry(e, { req, user: remoteUser, feature: FEATURE.USE_EXPENSES, extra: { expense } });
  }

  return updatedExpense;
}

export async function deleteExpense(req: express.Request, expenseId: number): Promise<Expense> {
  const { remoteUser } = req;
  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to delete an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await models.Expense.findByPk(expenseId, {
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    throw new NotFound('Expense not found');
  }

  if (!(await canDeleteExpense(req, expense))) {
    throw new Forbidden(
      "You don't have permission to delete this expense or it needs to be rejected before being deleted",
    );
  }

  await expense.destroy();
  return expense.reload({ paranoid: false });
}

async function payExpenseWithPayPalAdaptive(
  remoteUser,
  expense,
  host,
  paymentMethod,
  toPaypalEmail,
  fees = {},
): Promise<Expense> {
  debug('payExpenseWithPayPalAdaptive', expense.id);

  if (expense.currency !== expense.collective.currency) {
    throw new Error(
      'Multi-currency expenses are not supported by the legacy PayPal adaptive implementation. Please migrate to PayPal payouts: https://docs.opencollective.com/help/fiscal-hosts/payouts/payouts-with-paypal',
    );
  }

  if (parseToBoolean(process.env.DISABLE_PAYPAL_ADAPTIVE) && !remoteUser.isRoot()) {
    throw new Error('PayPal adaptive is currently under maintenance. Please try again later.');
  }

  let paymentResponse: Awaited<ReturnType<typeof paymentProviders.paypal.types.adaptive.pay>> = null;
  try {
    paymentResponse = await paymentProviders.paypal.types['adaptive'].pay(
      expense.collective,
      expense,
      toPaypalEmail,
      paymentMethod.token,
    );

    const { createPaymentResponse, executePaymentResponse } = paymentResponse;
    switch (executePaymentResponse.paymentExecStatus) {
      case 'COMPLETED':
        break;

      case 'CREATED':
        /*
         * When we don't provide a preapprovalKey (paymentMethod.token) to payServices['paypal'](),
         * it creates a payKey that we can use to redirect the user to PayPal.com to manually approve that payment
         * TODO We should handle that case on the frontend
         */
        throw new errors.BadRequest(
          `Please approve this payment manually on ${createPaymentResponse.paymentApprovalUrl}`,
        );

      case 'ERROR':
        // Backward compatible error message parsing
        // eslint-disable-next-line no-case-declarations
        const errorMessage =
          (executePaymentResponse.payErrorList as any)?.payError?.[0].error?.message ||
          executePaymentResponse.payErrorList?.[0].error?.message;
        throw new errors.ServerError(
          `Error while paying the expense with PayPal: "${errorMessage}". Please contact support@opencollective.com or pay it manually through PayPal.`,
        );

      default:
        throw new errors.ServerError(
          `Error while paying the expense with PayPal. Please contact support@opencollective.com or pay it manually through PayPal.`,
        );
    }

    // Warning senderFees can be null
    let senderFees = 0;
    const { defaultFundingPlan } = createPaymentResponse;
    if (defaultFundingPlan) {
      const senderFeesAmountFromFundingPlan = defaultFundingPlan.senderFees?.amount;
      if (senderFeesAmountFromFundingPlan) {
        senderFees = floatAmountToCents(parseFloat(senderFeesAmountFromFundingPlan));
      } else {
        // PayPal stopped providing senderFees in the response, we need to compute it ourselves
        // We don't have to check for feesPayer here because it is not supported for PayPal adaptive
        const { fundingAmount } = defaultFundingPlan;
        const amountPaidByTheHost = floatAmountToCents(parseFloat(fundingAmount.amount));
        const amountReceivedByPayee = expense.amount;
        senderFees = Math.round(amountPaidByTheHost - amountReceivedByPayee) || 0;

        // No example yet, but we want to know if this ever happens
        if (fundingAmount.code !== expense.currency) {
          reportMessageToSentry(`PayPal adaptive got a funding amount with a different currency than the expense`, {
            severity: 'error',
          });
        }
      }
    } else {
      // PayPal randomly omits the defaultFundingPlan, even though the transaction has payment processor fees attached.
      // We therefore need to fetch the information from the API
      // See https://github.com/opencollective/opencollective/issues/6581
      try {
        const payKey = createPaymentResponse.payKey;
        // Retrieve transaction ID
        const paymentDetails = await paypalAdaptive.paymentDetails({ payKey });
        const transactionId = paymentDetails.paymentInfoList.paymentInfo[0].transactionId;
        const toDate = moment().add(1, 'day'); // The transaction normally happened a few seconds ago, hit the API with a 1 day buffer to make sure we won't miss it
        const fromDate = moment(toDate).subtract(15, 'days');
        const { transactions } = await listPayPalTransactions(host, fromDate, toDate, {
          fields: 'transaction_info',
          currentPage: 1,
          transactionId,
        });
        senderFees = Math.abs(parseFloat(transactions[0].transaction_info.fee_amount.value));
        reportMessageToSentry('Transaction was missing defaultFundingPlan', {
          user: remoteUser,
          severity: 'warning',
          feature: FEATURE.PAYPAL_PAYOUTS,
          extra: { paymentResponse, payKey, transactionId, senderFees, expense: expense.info },
        });
      } catch (e) {
        reportErrorToSentry(e, {
          user: remoteUser,
          severity: 'error', // We want to be alerted, as this will prevent the expense fees from being recorded correctly
          feature: FEATURE.PAYPAL_PAYOUTS,
          extra: { paymentResponse, expense: expense.info },
        });
      }
    }

    const clearedAt = new Date(executePaymentResponse.responseEnvelope.timestamp);
    const currencyConversion = defaultFundingPlan?.currencyConversion || { exchangeRate: 1 };
    const hostCurrencyFxRate = 1 / parseFloat(currencyConversion.exchangeRate); // paypal returns a float from host.currency to expense.currency
    fees['paymentProcessorFeeInHostCurrency'] = Math.round(hostCurrencyFxRate * senderFees);

    // Set the paymentMethod so it's persisted to Expense and Transactions
    expense.setPaymentMethod(paymentMethod);
    await expense.save();
    // Adaptive does not work with multi-currency expenses, so we can safely assume that expense.currency = collective.currency
    await createTransactionsFromPaidExpense(host, expense, fees, hostCurrencyFxRate, { ...paymentResponse, clearedAt });
    // Mark Expense as Paid, create activity and send notifications
    await expense.markAsPaid({ user: remoteUser });
    await paymentMethod.updateBalance();
    return expense;
  } catch (err) {
    debug('paypal> error', JSON.stringify(err, null, '  '));
    if (
      err.message.indexOf('The total amount of all payments exceeds the maximum total amount for all payments') !== -1
    ) {
      throw new ValidationFailed(
        'Not enough funds in your existing Paypal preapproval. Please refill your PayPal payment balance.',
      );
    } else {
      reportErrorToSentry(err, {
        user: remoteUser,
        feature: FEATURE.PAYPAL_PAYOUTS,
        extra: { paymentResponse, toPaypalEmail, expense: expense.info },
      });

      throw new BadRequest(err.message);
    }
  }
}

const matchFxRateWithCurrency = (
  expectedSourceCurrency: string,
  expectedTargetCurrency: string,
  rateSourceCurrency: string,
  rateTargetCurrency: string,
  rate: number | null | undefined,
) => {
  if (!rate) {
    return null;
  } else if (expectedSourceCurrency === rateSourceCurrency && expectedTargetCurrency === rateTargetCurrency) {
    return rate;
  } else if (expectedSourceCurrency === rateTargetCurrency && expectedTargetCurrency === rateSourceCurrency) {
    return 1 / rate;
  }
};

export const getWiseFxRateInfoFromExpenseData = (
  expense,
  expectedSourceCurrency: string,
  expectedTargetCurrency: string,
) => {
  if (expectedSourceCurrency === expectedTargetCurrency) {
    return { value: 1 };
  }

  const wiseInfo: WiseTransfer | WiseQuote | WiseQuoteV2 | WiseQuoteV3 = expense.data?.transfer || expense.data?.quote;
  if (wiseInfo?.rate) {
    // In this context, the source currency is always the Host currency and the target currency is the Payee currency
    const wiseSourceCurrency = wiseInfo['sourceCurrency'] || wiseInfo['source'];
    const wiseTargetCurrency = wiseInfo['targetCurrency'] || wiseInfo['target'];
    // This makes the fxRate be the rate for Host -> Payee
    const fxRate = matchFxRateWithCurrency(
      expectedSourceCurrency,
      expectedTargetCurrency,
      wiseSourceCurrency,
      wiseTargetCurrency,
      wiseInfo.rate,
    );
    if (fxRate) {
      return {
        value: fxRate,
        date: new Date(wiseInfo['created'] || wiseInfo['createdTime']), // "created" for transfers, "createdTime" for quotes
        isFinal: Boolean(expense.data?.transfer),
      };
    }
  }
};

export async function setTransferWiseExpenseAsProcessing({ host, expense, data, feesInHostCurrency, remoteUser }) {
  await expense.update({ HostCollectiveId: host.id, data: { ...expense.data, ...data, feesInHostCurrency } });
  await expense.setProcessing(remoteUser.id);
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PROCESSING, remoteUser, {
    message: expense.data?.paymentOption?.formattedEstimatedDelivery
      ? `ETA: ${expense.data.paymentOption.formattedEstimatedDelivery}`
      : undefined,
    reference: expense.data?.transfer?.details?.reference,
    estimatedDelivery: expense.data?.quote?.paymentOption?.estimatedDelivery,
  });
  return expense;
}

/**
 * A soft lock on expenses, that works by adding a `isLocked` flag on expense's data
 */
const lockExpense = async (id, callback) => {
  // Lock expense
  await sequelize.transaction(async sqlTransaction => {
    const expense = await models.Expense.findByPk(id, { lock: true, transaction: sqlTransaction });

    if (!expense) {
      throw new NotFound('Expense not found');
    } else if (expense.data?.isLocked) {
      throw new Error('This expense is already been processed, please try again later');
    } else {
      return expense.update({ data: { ...expense.data, isLocked: true } }, { transaction: sqlTransaction });
    }
  });

  try {
    return await callback();
  } finally {
    // Unlock expense
    const expense = await models.Expense.findByPk(id);
    await expense.update({ data: { ...expense.data, isLocked: false } });
  }
};

type FeesArgs = {
  paymentProcessorFeeInCollectiveCurrency?: number;
  hostFeeInCollectiveCurrency?: number;
  platformFeeInCollectiveCurrency?: number;
};

/**
 * Estimates the fees for an expense
 */
export const getExpenseFees = async (
  expense,
  host,
  { fees = {}, payoutMethod, useExistingWiseData = false },
): Promise<{
  feesInHostCurrency: {
    paymentProcessorFeeInHostCurrency: number;
    hostFeeInHostCurrency: number;
    platformFeeInHostCurrency: number;
  };
  feesInExpenseCurrency: {
    paymentProcessorFee?: number;
    hostFee?: number;
    platformFee?: number;
  };
  feesInCollectiveCurrency: FeesArgs;
}> => {
  const resultFees = { ...fees };
  const feesInHostCurrency = {
    paymentProcessorFeeInHostCurrency: undefined,
    hostFeeInHostCurrency: undefined,
    platformFeeInHostCurrency: undefined,
  };

  if (!expense.collective) {
    expense.collective = await models.Collective.findByPk(expense.CollectiveId);
  }

  const collectiveToHostFxRate = await getFxRate(expense.collective.currency, host.currency);
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const existingQuote = expense.data?.quote;
    const existingPaymentOption = existingQuote?.paymentOption;
    if (
      useExistingWiseData &&
      existingQuote &&
      existingQuote.sourceCurrency === host.currency &&
      existingQuote.targetCurrency === payoutMethod.unfilteredData.currency &&
      existingPaymentOption
    ) {
      resultFees['paymentProcessorFeeInCollectiveCurrency'] = floatAmountToCents(
        existingPaymentOption.fee.total / collectiveToHostFxRate,
      );
    } else {
      const quote = await quoteExpense(expense);
      const paymentOption = quote.paymentOption;
      if (!paymentOption) {
        throw new BadRequest(`Could not find available payment option for this transaction.`, null, quote);
      }
      // Quote is always in host currency
      resultFees['paymentProcessorFeeInCollectiveCurrency'] = floatAmountToCents(
        paymentOption.fee.total / collectiveToHostFxRate,
      );
    }
  } else if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = await paymentProviders.paypal.types['adaptive'].fees({
      amount: expense.amount,
      currency: expense.collective.currency,
      host,
    });
  }

  // Build fees in host currency
  feesInHostCurrency.paymentProcessorFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['paymentProcessorFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.hostFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['hostFeeInCollectiveCurrency'] || 0),
  );
  feesInHostCurrency.platformFeeInHostCurrency = Math.round(
    collectiveToHostFxRate * (<number>resultFees['platformFeeInCollectiveCurrency'] || 0),
  );

  if (!resultFees['paymentProcessorFeeInCollectiveCurrency']) {
    resultFees['paymentProcessorFeeInCollectiveCurrency'] = 0;
  }

  // Build fees in expense currency
  let feesInExpenseCurrency = {};
  if (expense.currency === expense.collective.currency) {
    feesInExpenseCurrency = {
      paymentProcessorFee: resultFees['paymentProcessorFeeInCollectiveCurrency'],
      hostFee: resultFees['hostFeeInCollectiveCurrency'],
      platformFee: resultFees['platformFeeInCollectiveCurrency'],
    };
  } else {
    const collectiveToExpenseFxRate = await getFxRate(expense.collective.currency, expense.currency);
    const applyCollectiveToExpenseFxRate = (amount: number) => Math.round((amount || 0) * collectiveToExpenseFxRate);
    feesInExpenseCurrency = {
      paymentProcessorFee: applyCollectiveToExpenseFxRate(resultFees['paymentProcessorFeeInCollectiveCurrency']),
      hostFee: applyCollectiveToExpenseFxRate(resultFees['hostFeeInCollectiveCurrency']),
      platformFee: applyCollectiveToExpenseFxRate(resultFees['platformFeeInCollectiveCurrency']),
    };
  }

  return { feesInCollectiveCurrency: resultFees, feesInHostCurrency, feesInExpenseCurrency };
};

/**
 * Check if the collective balance is enough to pay the expense. Throws if not.
 */
export const checkHasBalanceToPayExpense = async (
  host,
  expense,
  payoutMethod,
  {
    forceManual = false,
    manualFees = {},
    useExistingWiseData = false,
    totalAmountPaidInHostCurrency = undefined,
    paymentProcessorFeeInHostCurrency = undefined,
  } = {},
) => {
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
  const balanceInCollectiveCurrency = await expense.collective.getBalanceWithBlockedFunds();
  const isSameCurrency = expense.currency === expense.collective.currency;

  if (expense.feesPayer === 'PAYEE') {
    assert(
      models.PayoutMethod.typeSupportsFeesPayer(payoutMethodType),
      'Putting the payment processor fees on the payee is only supported for bank accounts, manual payouts and stripe at the moment',
    );

    if (payoutMethodType !== PayoutMethodTypes.STRIPE) {
      assert(
        expense.currency === expense.collective.currency,
        'Cannot put the payment processor fees on the payee when the expense currency is not the same as the collective currency',
      );
    }
  }

  if (forceManual) {
    assert(totalAmountPaidInHostCurrency >= 0, 'Total amount paid must be positive');
    const collectiveToHostFxRate = await getFxRate(expense.collective.currency, host.currency);
    const balanceInHostCurrency = Math.round(balanceInCollectiveCurrency * collectiveToHostFxRate);
    if (expense.type !== ExpenseType.SETTLEMENT && balanceInHostCurrency < totalAmountPaidInHostCurrency) {
      throw new Error(
        `Collective does not have enough funds to pay this expense. Current balance: ${formatCurrency(
          balanceInHostCurrency,
          host.currency,
        )}, Expense amount: ${formatCurrency(totalAmountPaidInHostCurrency, host.currency)}`,
      );
    }
    return {
      feesInCollectiveCurrency: {},
      feesInHostCurrency: {
        paymentProcessorFeeInHostCurrency,
      },
      feesInExpenseCurrency: {},
    };
  }

  const exchangeStats =
    !isSameCurrency && (await models.CurrencyExchangeRate.getPairStats(expense.collective.currency, expense.currency));

  // Ensure the collective has enough funds to pay the expense, with an error margin of 2σ (standard deviations) the exchange rate of past 5 days
  // to account for fluctuating rates. If no exchange rate is available, fallback to the 20% rule.
  const assertMinExpectedBalance = (amountToPayInExpenseCurrency, feesInExpenseCurrency?) => {
    let defaultErrorMessage = `Collective does not have enough funds ${
      feesInExpenseCurrency ? 'to cover for the fees of this payment method' : 'to pay this expense'
    }. Current balance: ${formatCurrency(
      balanceInCollectiveCurrency,
      expense.collective.currency,
    )}, Expense amount: ${formatCurrency(expense.amount, expense.currency)}`;
    if (feesInExpenseCurrency) {
      defaultErrorMessage += `, Estimated ${payoutMethodType} fees: ${formatCurrency(
        feesInExpenseCurrency,
        expense.currency,
      )}`;
    }
    if (isSameCurrency) {
      if (balanceInCollectiveCurrency < amountToPayInExpenseCurrency) {
        throw new ValidationFailed(`${defaultErrorMessage}.`);
      }
    } else if (isNumber(exchangeStats?.latestRate)) {
      const rate = exchangeStats.latestRate - exchangeStats.stddev * 2;
      const safeAmount = Math.round(amountToPayInExpenseCurrency / rate);
      if (balanceInCollectiveCurrency < safeAmount) {
        throw new ValidationFailed(
          `${defaultErrorMessage}. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is ${formatCurrency(
            Math.round(balanceInCollectiveCurrency * rate),
            expense.currency,
          )}.`,
        );
      }
    } else {
      const safeAmount = Math.round(amountToPayInExpenseCurrency * 1.2);
      if (balanceInCollectiveCurrency < safeAmount) {
        throw new ValidationFailed(
          `${defaultErrorMessage}. For expenses submitted in a different currency than the collective, an error margin is applied to accommodate for fluctuations. The maximum amount that can be paid is ${formatCurrency(
            Math.round(balanceInCollectiveCurrency / 1.2),
            expense.collective.currency,
          )}.`,
        );
      }
    }
  };

  if (expense.type !== ExpenseType.SETTLEMENT) {
    // Check base balance before fees
    assertMinExpectedBalance(expense.amount);
  }

  const { feesInHostCurrency, feesInCollectiveCurrency, feesInExpenseCurrency } = await getExpenseFees(expense, host, {
    fees: manualFees,
    payoutMethod,
    useExistingWiseData,
  });

  // Estimate the total amount to pay from the collective, based on who's supposed to pay the fee
  let totalAmountToPay;
  if (expense.feesPayer === 'COLLECTIVE') {
    totalAmountToPay = expense.amount + feesInExpenseCurrency.paymentProcessorFee;
  } else if (expense.feesPayer === 'PAYEE') {
    totalAmountToPay = expense.amount; // Ignore the fee as it will be deduced from the payee
  } else {
    throw new Error(`Expense fee payer "${expense.feesPayer}" not supported yet`);
  }

  if (expense.type !== ExpenseType.SETTLEMENT) {
    // Ensure the collective has enough funds to cover the fees for this expense, with an error margin of 20% of the expense amount
    // to account for fluctuating rates. Example: to pay for a $100 expense in euros, the collective needs to have at least $120.
    assertMinExpectedBalance(totalAmountToPay, feesInExpenseCurrency.paymentProcessorFee);
  }

  return { feesInCollectiveCurrency, feesInExpenseCurrency, feesInHostCurrency, totalAmountToPay };
};

type PayExpenseArgs = {
  id: number;
  forceManual?: boolean;
  feesPayer?: 'COLLECTIVE' | 'PAYEE'; // Defaults to COLLECTIVE
  paymentProcessorFeeInHostCurrency?: number; // Defaults to 0
  totalAmountPaidInHostCurrency?: number;
  transferDetails?: CreateTransfer['details'];
  paymentMethodService?: PAYMENT_METHOD_SERVICE;
  clearedAt?: Date;
};

/**
 * Pay an expense based on the payout method defined in the Expense object
 * @PRE: fees { id, paymentProcessorFeeInCollectiveCurrency, hostFeeInCollectiveCurrency, platformFeeInCollectiveCurrency }
 * Note: some payout methods like PayPal will automatically define `paymentProcessorFeeInCollectiveCurrency`
 */
export async function payExpense(req: express.Request, args: PayExpenseArgs): Promise<Expense> {
  const { remoteUser } = req;
  const expenseId = args.id;
  const forceManual = Boolean(args.forceManual);

  if (!remoteUser) {
    throw new Unauthorized('You need to be logged in to pay an expense');
  } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
    throw new FeatureNotAllowedForUser();
  }

  const expense = await lockExpense(args.id, async () => {
    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.Collective, as: 'fromCollective' },
      ],
    });
    if (!expense) {
      throw new NotFound('Expense not found');
    }
    if (expense.status === ExpenseStatus.PAID) {
      throw new Forbidden('Expense has already been paid');
    }
    if (expense.status === ExpenseStatus.PROCESSING) {
      throw new Forbidden(
        'Expense is currently being processed, this means someone already started the payment process',
      );
    }
    if (
      expense.status !== ExpenseStatus.APPROVED &&
      // Allow errored expenses to be marked as paid
      expense.status !== ExpenseStatus.ERROR
    ) {
      throw new Forbidden(`Expense needs to be approved. Current status of the expense: ${expense.status}.`);
    }
    if (!(await canPayExpense(req, expense))) {
      throw new Forbidden("You don't have permission to pay this expense");
    }
    const host = await expense.collective.getHostCollective({ loaders: req.loaders });
    if (expense.currency !== expense.collective.currency && !hasMultiCurrency(expense.collective, host)) {
      throw new Forbidden('Multi-currency expenses are not enabled for this collective');
    }

    if (expense.legacyPayoutMethod === 'donation') {
      throw new Error('"In kind" donations are not supported anymore');
    }

    // Update the feesPayer right away because the rest of the process (i.e create transactions) depends on this
    if (args.feesPayer && args.feesPayer !== expense.feesPayer) {
      await expense.update({ feesPayer: args.feesPayer });
    }

    const totalAmountPaidInHostCurrency = args.totalAmountPaidInHostCurrency;
    const paymentProcessorFeeInHostCurrency = args.paymentProcessorFeeInHostCurrency || 0;
    const payoutMethod = await expense.getPayoutMethod();
    const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();
    const { feesInHostCurrency } = await checkHasBalanceToPayExpense(host, expense, payoutMethod, {
      forceManual,
      totalAmountPaidInHostCurrency,
      paymentProcessorFeeInHostCurrency,
      manualFees: <FeesArgs>(
        pick(args, [
          'paymentProcessorFeeInCollectiveCurrency',
          'hostFeeInCollectiveCurrency',
          'platformFeeInCollectiveCurrency',
        ])
      ),
    });

    // 2FA for payouts
    const isTwoFactorAuthenticationRequiredForPayoutMethod = [
      PayoutMethodTypes.PAYPAL,
      PayoutMethodTypes.BANK_ACCOUNT,
    ].includes(payoutMethodType);
    const hostHasPayoutTwoFactorAuthenticationEnabled = get(host, 'settings.payoutsTwoFactorAuth.enabled', false);
    const use2FARollingLimit =
      isTwoFactorAuthenticationRequiredForPayoutMethod && !forceManual && hostHasPayoutTwoFactorAuthenticationEnabled;

    const totalPaidExpensesAmountKey = `${req.remoteUser.id}_2fa_payment_limit`;
    let totalPaidExpensesAmount;

    if (use2FARollingLimit) {
      totalPaidExpensesAmount = await cache.get(totalPaidExpensesAmountKey);
      await validateExpensePayout2FALimit(req, host, expense, totalPaidExpensesAmountKey);
    } else {
      // Not using rolling limit, but still enforcing 2FA for all admins
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
    }

    try {
      if (forceManual) {
        const paymentMethod = args.paymentMethodService
          ? await host.findOrCreatePaymentMethod(args.paymentMethodService, PAYMENT_METHOD_TYPE.MANUAL)
          : null;
        await expense.update({ PaymentMethodId: paymentMethod?.id || null });
        await createTransactionsForManuallyPaidExpense(
          host,
          expense,
          paymentProcessorFeeInHostCurrency,
          totalAmountPaidInHostCurrency,
          { clearedAt: args.clearedAt },
        );
        await expense.update({
          // Remove all fields related to a previous automatic payment
          data: omit(expense.data, ['transfer', 'quote', 'fund', 'recipient', 'paymentOption']),
        });
      } else if (payoutMethodType === PayoutMethodTypes.PAYPAL) {
        if (expense.collective.currency !== host.currency) {
          throw new Error(
            'PayPal adaptive payouts are not supported when the collective currency is different from the host currency. Please migrate to PayPal payouts: https://docs.opencollective.com/help/fiscal-hosts/payouts/payouts-with-paypal',
          );
        }

        const paypalEmail = payoutMethod.data['email'];
        let paypalPaymentMethod = null;
        try {
          paypalPaymentMethod = await host.getPaymentMethod({ service: 'paypal', type: 'adaptive' });
        } catch {
          // ignore missing paypal payment method
        }
        // If the expense has been filed with the same paypal email than the host paypal
        // then we simply mark the expense as paid
        if (paypalPaymentMethod && paypalEmail === paypalPaymentMethod.name) {
          feesInHostCurrency['paymentProcessorFeeInHostCurrency'] = 0;
          await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto', { isManual: true });
        } else if (paypalPaymentMethod) {
          return payExpenseWithPayPalAdaptive(
            remoteUser,
            expense,
            host,
            paypalPaymentMethod,
            paypalEmail,
            feesInHostCurrency,
          );
        } else {
          throw new Error('No Paypal account linked, please reconnect Paypal or pay manually');
        }
      } else if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
        if (host.settings?.transferwise?.ott === true) {
          throw new Error('You cannot pay this expense directly without Scheduling it for payment first.');
        }
        const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE, {
          CreatedByUserId: remoteUser.id,
          fallbackToNonUserAccount: true,
        });

        const data = await paymentProviders.transferwise.payExpense(
          connectedAccount,
          payoutMethod,
          expense,
          undefined,
          args.transferDetails,
        );

        // Early return, Webhook will mark expense as Paid when the transaction completes.
        return setTransferWiseExpenseAsProcessing({
          host,
          expense,
          data,
          feesInHostCurrency,
          remoteUser,
        });
      } else if (payoutMethodType === PayoutMethodTypes.ACCOUNT_BALANCE) {
        const payee = expense.fromCollective;
        const payeeHost = await payee.getHostCollective({ loaders: req.loaders });
        if (!payeeHost) {
          throw new Error('The payee needs to have an Host to able to be paid on its Open Collective balance.');
        }
        if (host.id !== payeeHost.id) {
          throw new Error(
            'The payee needs to be on the same Host than the payer to be paid on its Open Collective balance.',
          );
        }
        // This will detect that payoutMethodType=ACCOUNT_BALANCE and set service=opencollective AND type=collective
        await expense.setAndSavePaymentMethodIfMissing();
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto', {
          clearedAt: args.clearedAt,
        });
      } else if (expense.legacyPayoutMethod === 'manual' || expense.legacyPayoutMethod === 'other') {
        const paymentMethod = args.paymentMethodService
          ? await host.findOrCreatePaymentMethod(args.paymentMethodService, PAYMENT_METHOD_TYPE.MANUAL)
          : null;
        await expense.update({ PaymentMethodId: paymentMethod?.id || null });
        await createTransactionsFromPaidExpense(host, expense, feesInHostCurrency, 'auto', {
          clearedAt: args.clearedAt,
        });
      }
    } catch (error) {
      if (use2FARollingLimit) {
        if (!isNil(totalPaidExpensesAmount) && totalPaidExpensesAmount !== 0) {
          cache.set(totalPaidExpensesAmountKey, totalPaidExpensesAmount - expense.amount, ROLLING_LIMIT_CACHE_VALIDITY);
        }
      }

      throw error;
    }

    // Mark Expense as Paid, create activity and send notifications
    await expense.markAsPaid({ user: remoteUser, isManualPayout: true });
    return expense;
  });

  return expense;
}

export async function markExpenseAsUnpaid(
  req: express.Request,
  expenseId: number,
  shouldRefundPaymentProcessorFee: boolean,
  markAsUnPaidStatus: ExpenseStatus.APPROVED | ExpenseStatus.ERROR | ExpenseStatus.INCOMPLETE = ExpenseStatus.APPROVED,
): Promise<Expense> {
  const newExpenseStatus = markAsUnPaidStatus || ExpenseStatus.APPROVED;

  const { remoteUser } = req;
  const { expense, transaction } = await lockExpense(expenseId, async () => {
    if (!remoteUser) {
      throw new Unauthorized('You need to be logged in to unpay an expense');
    } else if (!canUseFeature(remoteUser, FEATURE.USE_EXPENSES)) {
      throw new FeatureNotAllowedForUser();
    }

    const expense = await models.Expense.findByPk(expenseId, {
      include: [
        { model: models.Collective, as: 'collective' },
        { model: models.User, as: 'User' },
        { model: models.PayoutMethod },
      ],
    });

    if (!expense) {
      throw new NotFound('No expense found');
    }

    if (!(await canMarkAsUnpaid(req, expense))) {
      throw new Forbidden("You don't have permission to mark this expense as unpaid");
    }

    if (expense.status !== ExpenseStatus.PAID) {
      throw new Forbidden('Expense has not been paid yet');
    }

    const transaction = await models.Transaction.findOne({
      where: {
        ExpenseId: expenseId,
        RefundTransactionId: null,
        kind: TransactionKind.EXPENSE,
        isRefund: false,
      },
      include: [{ model: models.Expense }],
    });

    // Load payment processor fee amount, either from the column or from the related transaction
    let refundedPaymentProcessorFeeAmount = 0;
    if (shouldRefundPaymentProcessorFee) {
      refundedPaymentProcessorFeeAmount = transaction.paymentProcessorFeeInHostCurrency;
      if (!refundedPaymentProcessorFeeAmount) {
        refundedPaymentProcessorFeeAmount = Math.abs(
          (await transaction.getPaymentProcessorFeeTransaction().then(t => t?.amountInHostCurrency)) || 0,
        );
      }
    }

    await createRefundTransaction(transaction, refundedPaymentProcessorFeeAmount, null, expense.User);

    await expense.update({ status: newExpenseStatus, lastEditedById: remoteUser.id, PaymentMethodId: null });
    return { expense, transaction };
  });

  await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID, remoteUser, {
    ledgerTransaction: transaction,
  });

  if (newExpenseStatus === ExpenseStatus.INCOMPLETE) {
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE, req.remoteUser);
  }
  return expense;
}

export async function quoteExpense(expense_) {
  const expense = await models.Expense.findByPk(expense_.id, {
    include: [
      { model: models.Collective, as: 'collective' },
      { model: models.Collective, as: 'fromCollective' },
    ],
  });
  const payoutMethod = await expense.getPayoutMethod();
  const payoutMethodType = payoutMethod ? payoutMethod.type : expense.getPayoutMethodTypeFromLegacy();

  const host = await expense.collective.getHostCollective();
  if (!host) {
    throw new Error(
      expense.collective.deactivatedAt
        ? `@${expense.collective.slug} has been archived`
        : `Host not found for account @${expense.collective.slug}`,
    );
  }

  if (payoutMethodType === PayoutMethodTypes.BANK_ACCOUNT) {
    const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE);

    const recipientId =
      // Check if the recipient is the same as the one in the expense
      get(expense.data, 'recipient.payoutMethodId') === payoutMethod.id &&
      // Ignore recipient for BRL and NPR to avoid the missing Transfer Nature error
      !['BRL', 'NPR'].includes((payoutMethod.data as BankAccountPayoutMethodData)?.currency)
        ? expense.data.recipient?.id
        : undefined;

    const quote = await paymentProviders.transferwise.quoteExpense(
      connectedAccount,
      payoutMethod,
      expense,
      recipientId,
    );
    return quote;
  }
}

const { WISE, PAYPAL, OPENCOLLECTIVE } = CurrencyExchangeRateSourceTypeEnum;

export const getExpenseAmountInDifferentCurrency = async (expense: Expense, toCurrency, req: Express.Request) => {
  // Small helper to quickly generate an Amount object with fxRate
  const buildAmount = (
    fxRatePercentage: number,
    fxRateSource: CurrencyExchangeRateSourceTypeEnum,
    isApproximate: boolean,
    date = expense.createdAt,
  ) => ({
    value: Math.round(expense.amount * fxRatePercentage),
    currency: toCurrency,
    exchangeRate: {
      value: fxRatePercentage,
      source: fxRateSource,
      fromCurrency: expense.currency,
      toCurrency: toCurrency,
      date: date || expense.createdAt,
      isApproximate,
    },
  });

  // Simple case: no conversion needed
  if (toCurrency === expense.currency) {
    return { value: expense.amount, currency: expense.currency, exchangeRate: null };
  }

  // TODO: Can we retrieve something for virtual cards?
  if (expense.status === 'PAID') {
    const transactions = await req.loaders.Transaction.byExpenseId.load(expense.id);
    const transaction = find(transactions, { kind: TransactionKind.EXPENSE, isRefund: false, type: 'CREDIT' });
    // If requested currency matches the Host, return the precise amount in which the expense was accounted for.
    if (transaction && transaction.hostCurrency === toCurrency) {
      return {
        value: transaction.amountInHostCurrency,
        currency: transaction.hostCurrency,
        exchangeRate: null,
      };
    }
    const result = await req.loaders.Expense.expenseToHostTransactionFxRateLoader.load(expense.id);
    // If collective changed their currency since the expense was paid, we can't rely on transaction.currency
    if (!isNil(result?.rate) && (!expense.collective || expense.collective.currency === result.currency)) {
      return buildAmount(result.rate, OPENCOLLECTIVE, false, expense.createdAt);
    }
  }

  // Retrieve existing FX rate based from payment provider payload (for already paid or quoted stuff)
  const payoutMethod = expense.PayoutMethodId && (await req.loaders.PayoutMethod.byId.load(expense.PayoutMethodId));
  if (payoutMethod) {
    if (payoutMethod.type === PayoutMethodTypes.BANK_ACCOUNT) {
      const wiseFxRateInfo = getWiseFxRateInfoFromExpenseData(expense, expense.currency, toCurrency);
      if (wiseFxRateInfo) {
        return buildAmount(wiseFxRateInfo.value, WISE, !wiseFxRateInfo.isFinal, wiseFxRateInfo.date);
      }
    } else if (payoutMethod.type === PayoutMethodTypes.PAYPAL) {
      const currencyConversion = expense.data?.['currency_conversion'];
      if (currencyConversion) {
        const fxRate = matchFxRateWithCurrency(
          expense.currency,
          toCurrency,
          currencyConversion['from_amount']['currency'],
          currencyConversion['to_amount']['currency'],
          parseFloat(currencyConversion['exchange_rate']),
        );

        if (fxRate) {
          const date = expense.data?.time_processed ? new Date(expense.data.time_processed) : null;
          return buildAmount(fxRate, PAYPAL, false, date);
        }
      }
    }
  }

  // Fallback on internal system
  const fxRate = await req.loaders.CurrencyExchangeRate.fxRate.load({ fromCurrency: expense.currency, toCurrency });
  return buildAmount(fxRate, OPENCOLLECTIVE, true);
};

/**
 * DANGER: This function needs pre-authorization and permissions checks
 * Move expenses to destination account
 * @param expenses the list of models.Expense, with the collective association preloaded
 */
export const moveExpenses = async (req: express.Request, expenses: Expense[], destinationAccount: Collective) => {
  if (!expenses.length) {
    return [];
  } else if (destinationAccount.type === CollectiveType.USER) {
    throw new ValidationFailed('The "destinationAccount" must not be an USER account');
  }

  // -- Move expenses --
  const expenseIds: number[] = uniq(expenses.map(expense => expense.id));
  const recurringExpenseIds: number[] = uniq(expenses.map(expense => expense.RecurringExpenseId).filter(Boolean));
  const result = await sequelize.transaction(async dbTransaction => {
    const associatedTransactionsCount = await models.Transaction.count({
      where: { ExpenseId: expenseIds },
      transaction: dbTransaction,
    });

    if (associatedTransactionsCount > 0) {
      throw new ValidationFailed('Cannot move expenses with associated transactions');
    }

    // Moving associated models
    const [, updatedExpenses] = await models.Expense.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: true,
        where: { id: expenseIds },
        hooks: false,
      },
    );

    const [, updatedComments] = await models.Comment.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: ['id'],
        where: { ExpenseId: expenseIds },
        hooks: false,
      },
    );

    const [, updatedActivities] = await models.Activity.update(
      { CollectiveId: destinationAccount.id },
      {
        transaction: dbTransaction,
        returning: ['id'],
        where: { ExpenseId: expenseIds },
        hooks: false,
      },
    );

    let updatedRecurringExpenses = [];
    if (recurringExpenseIds.length) {
      [, updatedRecurringExpenses] = await models.RecurringExpense.update(
        { CollectiveId: destinationAccount.id },
        {
          transaction: dbTransaction,
          returning: ['id'],
          where: { id: recurringExpenseIds },
          hooks: false,
        },
      );
    }

    // Record the individual activities for moving the expenses
    await models.Activity.bulkCreate(
      updatedExpenses.map(expense => {
        const originalExpense = find(expenses, { id: expense.id });
        return {
          type: ActivityTypes.COLLECTIVE_EXPENSE_MOVED,
          UserId: req.remoteUser.id,
          UserTokenId: req.userToken?.id,
          FromCollectiveId: originalExpense.collective.id,
          CollectiveId: destinationAccount.id,
          HostCollectiveId: destinationAccount.HostCollectiveId,
          ExpenseId: expense.id,
          data: {
            expense: expense.info,
            movedFromCollective: originalExpense.collective.info,
            collective: destinationAccount.info,
          },
        };
      }),
      {
        transaction: dbTransaction,
        hooks: false, // Hooks are not playing well with `bulkCreate`, and we don't need to send any email here anyway
      },
    );

    // Record the migration log
    await models.MigrationLog.create(
      {
        type: MigrationLogType.MOVE_EXPENSES,
        description: `Moved ${updatedExpenses.length} expenses`,
        CreatedByUserId: req.remoteUser.id,
        data: {
          expenses: updatedExpenses.map(o => o.id),
          recurringExpenses: updatedRecurringExpenses.map(o => o.id),
          comments: updatedComments.map(c => c.id),
          activities: updatedActivities.map(a => a.id),
          destinationAccount: destinationAccount.id,
          previousExpenseValues: mapValues(keyBy(expenses, 'id'), expense => pick(expense, ['CollectiveId'])),
        },
      },
      { transaction: dbTransaction },
    );

    return updatedExpenses;
  });

  return result;
};

export async function holdExpense(req: express.Request, expense: Expense): Promise<Expense> {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to pay an expense');
  } else if (!(await canPutOnHold(req, expense))) {
    throw new FeatureNotAllowedForUser();
  }

  await expense.update({ lastEditedById: req.remoteUser.id, onHold: true });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_PUT_ON_HOLD, req.remoteUser);
  return expense;
}

export async function releaseExpense(req: express.Request, expense: Expense): Promise<Expense> {
  if (!req.remoteUser) {
    throw new Unauthorized('You need to be logged in to pay an expense');
  } else if (!(await canReleaseHold(req, expense))) {
    throw new FeatureNotAllowedForUser();
  }

  await expense.update({ lastEditedById: req.remoteUser.id, onHold: false });
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_RELEASED_FROM_HOLD, req.remoteUser);
  return expense;
}
