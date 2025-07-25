import assert from 'assert';

import config from 'config';
import type express from 'express';
import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime, GraphQLNonEmptyString } from 'graphql-scalars';
import { compact, find, get, isEmpty, isNil, keyBy, mapValues, set, uniq } from 'lodash';
import moment from 'moment';

import { roles } from '../../../constants';
import ActivityTypes from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import expenseType from '../../../constants/expense-type';
import { HOST_FEE_STRUCTURE } from '../../../constants/host-fee-structure';
import OrderStatuses from '../../../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import POLICIES from '../../../constants/policies';
import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import { FEATURE, hasFeature } from '../../../lib/allowed-features';
import { getPolicy } from '../../../lib/policies';
import SQLQueries from '../../../lib/queries';
import sequelize from '../../../lib/sequelize';
import { buildSearchConditions } from '../../../lib/sql-search';
import { getHostReportNodesFromQueryResult } from '../../../lib/transaction-reports';
import { ifStr, parseToBoolean } from '../../../lib/utils';
import models, { Collective, ConnectedAccount, Op, TransactionsImportRow } from '../../../models';
import { AccountingCategoryAppliesTo } from '../../../models/AccountingCategory';
import Agreement from '../../../models/Agreement';
import { LEGAL_DOCUMENT_TYPE } from '../../../models/LegalDocument';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { checkRemoteUserCanUseHost, checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { Unauthorized, ValidationFailed } from '../../errors';
import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { GraphQLAccountingCategoryCollection } from '../collection/AccountingCategoryCollection';
import { GraphQLAgreementCollection } from '../collection/AgreementCollection';
import { GraphQLTransactionsImportRowCollection } from '../collection/GraphQLTransactionsImportRow';
import { GraphQLHostApplicationCollection } from '../collection/HostApplicationCollection';
import { GraphQLHostedAccountCollection } from '../collection/HostedAccountCollection';
import { GraphQLLegalDocumentCollection } from '../collection/LegalDocumentCollection';
import { GraphQLTransactionsImportsCollection } from '../collection/TransactionsImportsCollection';
import { GraphQLVendorCollection } from '../collection/VendorCollection';
import { GraphQLVirtualCardCollection } from '../collection/VirtualCardCollection';
import {
  AccountTypeToModelMapping,
  GraphQLAccountType,
  GraphQLPaymentMethodLegacyType,
  GraphQLPayoutMethodType,
} from '../enum';
import { GraphQLAccountingCategoryKind } from '../enum/AccountingCategoryKind';
import { GraphQLHostApplicationStatus } from '../enum/HostApplicationStatus';
import GraphQLHostContext from '../enum/HostContext';
import { GraphQLHostFeeStructure } from '../enum/HostFeeStructure';
import { GraphQLLastCommentBy } from '../enum/LastCommentByType';
import { GraphQLLegalDocumentRequestStatus } from '../enum/LegalDocumentRequestStatus';
import { GraphQLLegalDocumentType } from '../enum/LegalDocumentType';
import { PaymentMethodLegacyTypeEnum } from '../enum/PaymentMethodLegacyType';
import { GraphQLTimeUnit } from '../enum/TimeUnit';
import { GraphQLTransactionsImportRowStatus, TransactionsImportRowStatus } from '../enum/TransactionsImportRowStatus';
import { GraphQLTransactionsImportStatus } from '../enum/TransactionsImportStatus';
import { GraphQLTransactionsImportType } from '../enum/TransactionsImportType';
import { GraphQLVirtualCardStatusEnum } from '../enum/VirtualCardStatus';
import { idDecode } from '../identifiers';
import {
  fetchAccountsIdsWithReference,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import {
  ACCOUNT_BALANCE_QUERY,
  ACCOUNT_CONSOLIDATED_BALANCE_QUERY,
  getAmountRangeValueAndOperator,
  GraphQLAmountRangeInput,
} from '../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../input/ChronologicalOrderInput';
import { GraphQLOrderByInput, ORDER_BY_PSEUDO_FIELDS } from '../input/OrderByInput';
import { GraphQLTransactionsImportRowOrderInput } from '../input/TransactionsImportRowOrderInput';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';
import { CollectionArgs, getCollectionArgs } from '../interface/Collection';
import URL from '../scalar/URL';

import { GraphQLContributionStats } from './ContributionStats';
import { GraphQLExpenseStats } from './ExpenseStats';
import { GraphQLHostExpensesReports } from './HostExpensesReport';
import { GraphQLHostMetrics } from './HostMetrics';
import { GraphQLHostMetricsTimeSeries } from './HostMetricsTimeSeries';
import { GraphQLHostPlan } from './HostPlan';
import { GraphQLHostStats } from './HostStats';
import { GraphQLHostTransactionReports } from './HostTransactionReports';
import { GraphQLTransactionsImportStats } from './OffPlatformTransactionsStats';
import { GraphQLPaymentMethod } from './PaymentMethod';
import GraphQLPayoutMethod from './PayoutMethod';
import { GraphQLStripeConnectedAccount } from './StripeConnectedAccount';

const getFilterDateRange = (startDate, endDate) => {
  let dateRange;
  if (startDate && endDate) {
    dateRange = { [Op.gte]: startDate, [Op.lt]: endDate };
  } else if (startDate) {
    dateRange = { [Op.gte]: startDate };
  } else if (endDate) {
    dateRange = { [Op.lt]: endDate };
  }
  return dateRange;
};

const getNumberOfDays = (startDate, endDate, host) => {
  const momentStartDate = startDate && moment(startDate);
  const momentCreated = moment(host.createdAt);
  const momentFrom = momentStartDate?.isAfter(momentCreated) ? momentStartDate : momentCreated; // We bound the date range to the host creation date
  const momentTo = moment(endDate || undefined); // Defaults to Today
  return Math.abs(momentFrom.diff(momentTo, 'days'));
};

const getTimeUnit = numberOfDays => {
  if (numberOfDays < 21) {
    return 'DAY'; // Up to 3 weeks
  } else if (numberOfDays < 90) {
    return 'WEEK'; // Up to 3 months
  } else if (numberOfDays < 365 * 3) {
    return 'MONTH'; // Up to 3 years
  } else {
    return 'YEAR';
  }
};

export const GraphQLHost = new GraphQLObjectType({
  name: 'Host',
  description: 'This represents an Host account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions],
  // Due to overlap between our Organization and Host types, we cannot use isTypeOf here
  // isTypeOf: account => account.isHostAccount,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      location: {
        ...AccountFields.location,
        async resolve(host, _, req) {
          // Hosts locations are always public
          return req.loaders.Location.byCollectiveId.load(host.id);
        },
      },
      accountingCategories: {
        type: new GraphQLNonNull(GraphQLAccountingCategoryCollection),
        description: 'List of accounting categories for this host',
        args: {
          kind: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountingCategoryKind)),
            description: 'Filter accounting categories by kind',
          },
          account: {
            type: GraphQLAccountReferenceInput,
            description: 'Filter by accounting category applicable to this account',
          },
        },
        // Not paginated yet as we don't expect to have too many categories for now
        async resolve(host, args, req) {
          const where: Parameters<typeof models.AccountingCategory.findAll>[0]['where'] = { CollectiveId: host.id };
          const order: Parameters<typeof models.AccountingCategory.findAll>[0]['order'] = [['code', 'ASC']]; // Code is unique per host, so sorting on it here should be consistent
          if (args.kind) {
            where.kind = uniq(args.kind);
          }

          if (!req.remoteUser?.isAdmin(host.id)) {
            where.hostOnly = false;
          }

          const account = args.account
            ? await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true })
            : null;

          if (account) {
            where.appliesTo = [account.id, account.ParentCollectiveId].includes(host.id)
              ? AccountingCategoryAppliesTo.HOST
              : AccountingCategoryAppliesTo.HOSTED_COLLECTIVES;
          }

          const categories = await models.AccountingCategory.findAll({ where, order });
          return {
            nodes: categories,
            totalCount: categories.length,
            limit: categories.length,
            offset: 0,
          };
        },
      },
      hostFeePercent: {
        type: GraphQLFloat,
        resolve(collective) {
          return collective.hostFeePercent;
        },
      },
      totalHostedCollectives: {
        type: GraphQLInt,
        deprecationReason: '2023-03-20: Renamed to totalHostedAccounts',
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      totalHostedAccounts: {
        type: GraphQLInt,
        resolve(host, _, req) {
          return req.loaders.Collective.hostedCollectivesCount.load(host.id);
        },
      },
      isOpenToApplications: {
        type: GraphQLBoolean,
        resolve(collective) {
          return collective.canApply();
        },
      },
      termsUrl: {
        type: URL,
        resolve(collective) {
          return get(collective, 'settings.tos');
        },
      },
      plan: {
        type: new GraphQLNonNull(GraphQLHostPlan),
        resolve(host) {
          return host.getPlan();
        },
      },
      hostTransactionsReports: {
        type: GraphQLHostTransactionReports,
        description: 'EXPERIMENTAL (this may change or be removed)',
        args: {
          timeUnit: {
            type: GraphQLTimeUnit,
            defaultValue: 'MONTH',
          },
          dateFrom: {
            type: GraphQLDateTime,
          },
          dateTo: {
            type: GraphQLDateTime,
          },
        },
        resolve: async (host, args) => {
          if (args.timeUnit !== 'MONTH' && args.timeUnit !== 'QUARTER' && args.timeUnit !== 'YEAR') {
            throw new Error('Only monthly, quarterly and yearly reports are supported.');
          }

          const refreshedAtQuery = `
            SELECT "refreshedAt" FROM "HostMonthlyTransactions" LIMIT 1;
          `;

          const refreshedAtResult = await sequelize.query(refreshedAtQuery, {
            replacements: {
              hostCollectiveId: host.id,
            },
            type: sequelize.QueryTypes.SELECT,
            raw: true,
          });

          const refreshedAt = refreshedAtResult[0]?.refreshedAt;

          const query = `
            WITH
                HostCollectiveIds AS (
                    SELECT "id"
                    FROM "Collectives"
                    WHERE "id" = :hostCollectiveId OR ("ParentCollectiveId" = :hostCollectiveId AND "type" != 'VENDOR')
                ),
                AggregatedTransactions AS (
                    SELECT
                        DATE_TRUNC(:timeUnit, t."createdAt" AT TIME ZONE 'UTC') AS "date",
                        t."HostCollectiveId",
                        SUM(t."amountInHostCurrency") AS "amountInHostCurrency",
                        SUM(COALESCE(t."platformFeeInHostCurrency", 0)) AS "platformFeeInHostCurrency",
                        SUM(COALESCE(t."hostFeeInHostCurrency", 0)) AS "hostFeeInHostCurrency",
                        SUM(
                            COALESCE(t."paymentProcessorFeeInHostCurrency", 0)
                        ) AS "paymentProcessorFeeInHostCurrency",
                        SUM(
                            COALESCE(
                                t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1),
                                0
                            )
                        ) AS "taxAmountInHostCurrency",
                        COALESCE(
                            SUM(COALESCE(t."amountInHostCurrency", 0)) + SUM(COALESCE(t."platformFeeInHostCurrency", 0)) + SUM(COALESCE(t."hostFeeInHostCurrency", 0)) + SUM(
                                COALESCE(t."paymentProcessorFeeInHostCurrency", 0)
                            ) + SUM(
                                COALESCE(
                                    t."taxAmount" * COALESCE(t."hostCurrencyFxRate", 1),
                                    0
                                )
                            ),
                            0
                        ) AS "netAmountInHostCurrency",
                        t."kind",
                        t."isRefund",
                        t."hostCurrency",
                        t."type",
                        CASE
                            WHEN t."CollectiveId" IN (SELECT * FROM HostCollectiveIds) THEN TRUE ELSE FALSE
                        END AS "isHost",
                        e."type" AS "expenseType"
                    FROM
                        "Transactions" t
                        LEFT JOIN LATERAL (
                            SELECT
                                e2."type"
                            FROM
                                "Expenses" e2
                            WHERE
                                e2.id = t."ExpenseId"
                        ) AS e ON t."ExpenseId" IS NOT NULL
                    WHERE
                        t."deletedAt" IS NULL
                        AND t."HostCollectiveId" = :hostCollectiveId
                        AND t."createdAt" > :refreshedAt
                        ${args.dateTo ? 'AND t."createdAt" <= :dateTo' : ''}

                    GROUP BY
                        DATE_TRUNC(:timeUnit, t."createdAt" AT TIME ZONE 'UTC'),
                        t."HostCollectiveId",
                        t."kind",
                        t."hostCurrency",
                        t."isRefund",
                        t."type",
                        "isHost",
                        "expenseType"
                ),
                CombinedData AS (
                    SELECT
                        "date",
                        "HostCollectiveId",
                        "amountInHostCurrency",
                        "platformFeeInHostCurrency",
                        "hostFeeInHostCurrency",
                        "paymentProcessorFeeInHostCurrency",
                        "taxAmountInHostCurrency",
                        "netAmountInHostCurrency",
                        "kind",
                        "isRefund",
                        "hostCurrency",
                        "type",
                        "isHost",
                        "expenseType"
                    FROM
                        AggregatedTransactions
                    UNION ALL
                    SELECT
                        DATE_TRUNC(:timeUnit, "date" AT TIME ZONE 'UTC') AS "date",
                        "HostCollectiveId",
                        "amountInHostCurrency",
                        "platformFeeInHostCurrency",
                        "hostFeeInHostCurrency",
                        "paymentProcessorFeeInHostCurrency",
                        "taxAmountInHostCurrency",
                        "netAmountInHostCurrency",
                        "kind",
                        "isRefund",
                        "hostCurrency",
                        "type",
                        "isHost",
                        "expenseType"
                    FROM
                        "HostMonthlyTransactions"
                    WHERE
                        "HostCollectiveId" = :hostCollectiveId
                        ${args.dateTo ? 'AND "date" <= :dateTo' : ''}
                )
            SELECT
                "date",
                "isRefund",
                "isHost",
                "kind",
                "type",
                "expenseType",
                "hostCurrency",
                SUM("platformFeeInHostCurrency") AS "platformFeeInHostCurrency",
                SUM("hostFeeInHostCurrency") AS "hostFeeInHostCurrency",
                SUM("paymentProcessorFeeInHostCurrency") AS "paymentProcessorFeeInHostCurrency",
                SUM("taxAmountInHostCurrency") AS "taxAmountInHostCurrency",
                SUM("netAmountInHostCurrency") AS "netAmountInHostCurrency",
                SUM("amountInHostCurrency") AS "amountInHostCurrency"
            FROM
                CombinedData
            GROUP BY
                "date",
                "isRefund",
                "isHost",
                "kind",
                "type",
                "expenseType",
                "hostCurrency"
            ORDER BY
                "date";
          `;

          const queryResult = await sequelize.query(query, {
            replacements: {
              hostCollectiveId: host.id,
              timeUnit: args.timeUnit,
              dateTo: moment(args.dateTo).utc().toISOString(),
              refreshedAt,
            },
            type: sequelize.QueryTypes.SELECT,
            raw: true,
          });

          const nodes = await getHostReportNodesFromQueryResult({
            queryResult,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            timeUnit: args.timeUnit,
            currency: host.currency,
          });

          return {
            timeUnit: args.timeUnit,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            nodes,
          };
        },
      },
      hostStats: {
        type: new GraphQLNonNull(GraphQLHostStats),
        args: {
          hostContext: {
            type: GraphQLHostContext,
            defaultValue: 'ALL',
          },
        },
        async resolve(host, args) {
          let collectiveIds: number[];

          const allHostedCollectiveIds = (await host.getHostedCollectives({ attributes: ['id'], raw: true })).map(
            ({ id }) => id,
          );

          if (args.hostContext === 'ALL') {
            collectiveIds = allHostedCollectiveIds;
          } else {
            const hostInternalChildren = (await host.getChildren({ attributes: ['id'], raw: true })).map(
              ({ id }) => id,
            );
            const hostInternalIds = [host.id, ...hostInternalChildren];
            if (args.hostContext === 'INTERNAL') {
              collectiveIds = hostInternalIds;
            } else if (args.hostContext === 'HOSTED') {
              collectiveIds = allHostedCollectiveIds.filter(collectiveId => !hostInternalIds.includes(collectiveId));
            }
          }
          return { host, collectiveIds };
        },
      },
      hostMetrics: {
        type: new GraphQLNonNull(GraphQLHostMetrics),
        deprecationReason: '2025-06-24: Low performance query, see if `hostStats` is sufficient',
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
        },
        async resolve(host, args) {
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, {
              attributes: ['id'],
            });
            collectiveIds = collectives.map(collective => collective.id);
          }
          const metrics = await host.getHostMetrics(args.dateFrom || args.from, args.dateTo || args.to, collectiveIds);
          const toAmount = value => ({ value, currency: host.currency });
          return mapValues(metrics, (value, key) => (key.includes('Percent') ? value : toAmount(value)));
        },
      },
      hostMetricsTimeSeries: {
        type: new GraphQLNonNull(GraphQLHostMetricsTimeSeries),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the metrics should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'The start date of the time series',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'The end date of the time series',
          },
          timeUnit: {
            type: GraphQLTimeUnit,
            description:
              'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
          },
        },
        async resolve(host, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, host) || 1);
          const collectiveIds = args.account && (await fetchAccountsIdsWithReference(args.account));
          return { host, collectiveIds, timeUnit, dateFrom, dateTo };
        },
      },
      hostExpensesReport: {
        type: GraphQLHostExpensesReports,
        description: 'EXPERIMENTAL (this may change or be removed)',
        args: {
          timeUnit: {
            type: GraphQLTimeUnit,
            defaultValue: 'MONTH',
          },
          dateFrom: {
            type: GraphQLDateTime,
          },
          dateTo: {
            type: GraphQLDateTime,
          },
        },
        /**
         * @param {import("../../../models/Collective").default} host
         * @param {{ timeUnit: import("../enum/TimeUnit").TimeUnit; dateFrom: Date; dateTo: Date }} args
         */
        resolve: async (host, args) => {
          if (args.timeUnit !== 'MONTH' && args.timeUnit !== 'QUARTER' && args.timeUnit !== 'YEAR') {
            throw new Error('Only monthly, quarterly and yearly reports are supported.');
          }

          const query = `
            WITH HostCollectiveIds AS (
              SELECT "id" FROM "Collectives"
              WHERE "id" = :hostCollectiveId
              OR ("ParentCollectiveId" = :hostCollectiveId AND "type" != 'VENDOR')
            )
            SELECT
              DATE_TRUNC(:timeUnit, e."createdAt" AT TIME ZONE 'UTC') AS "date",
              SUM(t."amountInHostCurrency") AS "amount",
              (SELECT "currency" FROM "Collectives" where id = :hostCollectiveId) as "currency",
              COUNT(e."id") AS "count",
              CASE
                  WHEN e."CollectiveId" IN (SELECT * FROM HostCollectiveIds) THEN TRUE ELSE FALSE
              END AS "isHost",
              e."AccountingCategoryId"

            FROM "Expenses" e
            JOIN "Transactions" t ON t."ExpenseId" = e.id

            WHERE e."HostCollectiveId" = :hostCollectiveId
            AND t."kind" = 'EXPENSE' AND t."type" = 'CREDIT' AND NOT t."isRefund" AND t."RefundTransactionId" IS NULL AND t."deletedAt" IS NULL
            AND e."status" = 'PAID'
            AND e."deletedAt" IS NULL
            ${args.dateFrom ? 'AND e."createdAt" >= :dateFrom' : ''}
            ${args.dateTo ? 'AND e."createdAt" <= :dateTo' : ''}

            GROUP BY "date", "isHost", e."AccountingCategoryId"
          `;

          const queryResult = await sequelize.query(query, {
            replacements: {
              hostCollectiveId: host.id,
              timeUnit: args.timeUnit,
              dateTo: moment(args.dateTo).utc().toISOString(),
              dateFrom: moment(args.dateFrom).utc().toISOString(),
            },
            type: sequelize.QueryTypes.SELECT,
            raw: true,
          });

          return {
            timeUnit: args.timeUnit,
            dateFrom: args.dateFrom,
            dateTo: args.dateTo,
            nodes: queryResult,
          };
        },
      },
      supportedPaymentMethods: {
        type: new GraphQLList(GraphQLPaymentMethodLegacyType),
        description:
          'The list of payment methods (Stripe, Paypal, manual bank transfer, etc ...) the Host can accept for its Collectives',
        async resolve(collective, _, req) {
          const supportedPaymentMethods = [];

          // Paypal, Stripe = connected accounts
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(collective.id);

          if (find(connectedAccounts, ['service', 'stripe'])) {
            supportedPaymentMethods.push('CREDIT_CARD');
            if (
              parseToBoolean(config.stripe.paymentIntentEnabled) ||
              hasFeature(collective, FEATURE.STRIPE_PAYMENT_INTENT)
            ) {
              supportedPaymentMethods.push(PaymentMethodLegacyTypeEnum.PAYMENT_INTENT);
            }
          }

          if (find(connectedAccounts, ['service', 'paypal']) && !collective.settings?.disablePaypalDonations) {
            supportedPaymentMethods.push('PAYPAL');
          }

          // bank transfer = manual in host settings
          if (get(collective, 'settings.paymentMethods.manual', null)) {
            supportedPaymentMethods.push('BANK_TRANSFER');
          }

          return supportedPaymentMethods;
        },
      },
      bankAccount: {
        type: GraphQLPayoutMethod,
        async resolve(collective, _, req) {
          const payoutMethods = await req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
          const payoutMethod = payoutMethods.find(c => c.type === 'BANK_ACCOUNT' && c.data?.isManualBankTransfer);
          if (payoutMethod && get(collective, 'settings.paymentMethods.manual')) {
            // Make bank account's data public if manual payment method is enabled
            allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id);
          }

          return payoutMethod;
        },
      },
      paypalPreApproval: {
        type: GraphQLPaymentMethod,
        description: 'Paypal preapproval info. Returns null if PayPal account is not connected.',
        resolve: async host => {
          return models.PaymentMethod.findOne({
            where: {
              CollectiveId: host.id,
              service: PAYMENT_METHOD_SERVICE.PAYPAL,
              type: PAYMENT_METHOD_TYPE.ADAPTIVE,
            },
          });
        },
      },
      paypalClientId: {
        type: GraphQLString,
        description: 'If the host supports PayPal, this will contain the client ID to use in the frontend',
        resolve: async (host, _, req) => {
          const connectedAccounts = await req.loaders.Collective.connectedAccounts.load(host.id);
          const paypalAccount = connectedAccounts.find(c => c.service === 'paypal');
          return paypalAccount?.clientId || null;
        },
      },
      supportedPayoutMethods: {
        type: new GraphQLList(GraphQLPayoutMethodType),
        description: 'The list of payout methods this Host accepts for its expenses',
        async resolve(host, _, req) {
          const connectedAccounts: ConnectedAccount[] = await req.loaders.Collective.connectedAccounts.load(host.id);
          const supportedPayoutMethods = [
            PayoutMethodTypes.ACCOUNT_BALANCE,
            PayoutMethodTypes.BANK_ACCOUNT,
            PayoutMethodTypes.STRIPE,
          ];

          // Check for PayPal
          if (connectedAccounts?.find?.(c => c.service === 'paypal') && !host.settings?.disablePaypalPayouts) {
            supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL); // Payout
          } else {
            try {
              if (await host.getPaymentMethod({ service: 'paypal', type: 'adaptive' })) {
                supportedPayoutMethods.push(PayoutMethodTypes.PAYPAL); // Adaptive
              }
            } catch {
              // ignore missing paypal payment method
            }
          }

          if (!host.settings?.disableCustomPayoutMethod) {
            supportedPayoutMethods.push(PayoutMethodTypes.OTHER);
          }

          return supportedPayoutMethods;
        },
      },
      stripe: {
        type: GraphQLStripeConnectedAccount,
        description: 'Stripe connected account',
        async resolve(host, _, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          try {
            return await host.getAccountForPaymentProvider('stripe');
          } catch {
            return null;
          }
        },
      },
      hostApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Applications for this host',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description: 'Search term for collective tags, id, name, slug and description.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
          status: {
            type: GraphQLHostApplicationStatus,
            description: 'Filter applications by status',
          },
          lastCommentBy: {
            type: new GraphQLList(GraphQLLastCommentBy),
            description: 'Filter host applications by the last user-role who replied to them',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its applications');
          }

          const where = {};

          if (args.lastCommentBy?.length) {
            const conditions = [];
            const CollectiveIds = compact([
              args.lastCommentBy.includes('COLLECTIVE_ADMIN') && '"HostApplication"."CollectiveId"',
              args.lastCommentBy.includes('HOST_ADMIN') && `"collective"."HostCollectiveId"`,
            ]);

            // Collective Conditions
            if (CollectiveIds.length) {
              conditions.push(
                sequelize.literal(
                  `(SELECT "FromCollectiveId" FROM "Comments" WHERE "Comments"."HostApplicationId" = "HostApplication"."id" ORDER BY "Comments"."createdAt" DESC LIMIT 1)
                    IN (
                      SELECT "MemberCollectiveId" FROM "Members" WHERE
                      "role" = 'ADMIN' AND "deletedAt" IS NULL AND
                      "CollectiveId" IN (${CollectiveIds.join(',')})
                  )`,
                ),
              );
            }

            where[Op.and] = where[Op.and] || [];
            where[Op.and].push(conditions.length > 1 ? { [Op.or]: conditions } : conditions[0]);
          }

          where['HostCollectiveId'] = host.id;
          if (args.status) {
            where['status'] = args.status;
          }

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
          });

          const { rows, count } = await models.HostApplication.findAndCountAll({
            order: [[args.orderBy.field, args.orderBy.direction]],
            where,
            limit: args.limit,
            offset: args.offset,
            include: [
              {
                model: models.Collective,
                as: 'collective',
                required: true,
                where: {
                  ...(args.status !== 'REJECTED' && {
                    HostCollectiveId: host.id,
                  }),
                  ...(searchTermConditions.length && { [Op.or]: searchTermConditions }),
                },
              },
            ],
          });

          return { totalCount: count, limit: args.limit, offset: args.offset, nodes: rows };
        },
      },
      pendingApplications: {
        type: new GraphQLNonNull(GraphQLHostApplicationCollection),
        description: 'Pending applications for this host',
        deprecationReason: '2023-08-25: Deprecated in favour of host.hostApplications(status: PENDING).',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
            description: 'Order of the results',
          },
        },
        resolve: async (host, args, req) => {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its pending application');
          }

          const applyTypes = [CollectiveType.COLLECTIVE, CollectiveType.FUND];
          const where = { HostCollectiveId: host.id, approvedAt: null, type: { [Op.in]: applyTypes } };

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description', 'longDescription'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
          });

          if (searchTermConditions.length) {
            where[Op.or] = searchTermConditions;
          }

          const result = await models.Collective.findAndCountAll({
            where,
            limit: args.limit,
            offset: args.offset,
            order: [[args.orderBy.field, args.orderBy.direction]],
          });

          // Link applications to collectives
          const collectiveIds = result.rows.map(collective => collective.id);
          const applications = await models.HostApplication.findAll({
            order: [['updatedAt', 'DESC']],
            where: {
              HostCollectiveId: host.id,
              status: 'PENDING',
              CollectiveId: collectiveIds ? { [Op.in]: collectiveIds } : undefined,
            },
          });
          const groupedApplications = keyBy(applications, 'CollectiveId');
          const nodes = result.rows.map(collective => {
            const application = groupedApplications[collective.id];
            if (application) {
              application.collective = collective;
              return application;
            } else {
              return { collective };
            }
          });

          return { totalCount: result.count, limit: args.limit, offset: args.offset, nodes };
        },
      },
      hostedVirtualCards: {
        type: new GraphQLNonNull(GraphQLVirtualCardCollection),
        args: {
          searchTerm: { type: GraphQLString, description: 'Search term (card name, card last four digits)' },
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
          state: { type: GraphQLString, defaultValue: null, deprecationReason: '2023-06-12: Please use status.' },
          status: { type: new GraphQLList(GraphQLVirtualCardStatusEnum) },
          orderBy: { type: GraphQLChronologicalOrderInput, defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE },
          merchantAccount: { type: GraphQLAccountReferenceInput, defaultValue: null },
          collectiveAccountIds: { type: new GraphQLList(GraphQLAccountReferenceInput), defaultValue: null },
          withExpensesDateFrom: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses from this date.',
          },
          withExpensesDateTo: {
            type: GraphQLDateTime,
            description: 'Returns virtual cards with expenses to this date.',
          },
          spentAmountFrom: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with at least this amount in cents charged',
          },
          spentAmountTo: {
            type: GraphQLAmountInput,
            description: 'Filter virtual cards with up to this amount in cents charged',
          },
          hasMissingReceipts: {
            type: GraphQLBoolean,
            description: 'Filter virtual cards by whether they are missing receipts for any charges',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its hosted virtual cards');
          }

          const hasStatusFilter = !isEmpty(args.status);
          const hasCollectiveFilter = !isEmpty(args.collectiveAccountIds);
          const hasMerchantFilter = !isNil(args.merchantId);

          const hasSpentFromFilter = !isNil(args.spentAmountFrom);
          const hasSpentToFilter = !isNil(args.spentAmountTo);
          const hasSpentFilter = hasSpentFromFilter || hasSpentToFilter;

          const hasExpenseFromDate = !isNil(args.withExpensesDateFrom);
          const hasExpenseToDate = !isNil(args.withExpensesDateTo);
          const hasExpensePeriodFilter = hasExpenseFromDate || hasExpenseToDate;
          const hasSearchTerm = !isNil(args.searchTerm) && args.searchTerm.length !== 0;
          const searchTerm = `%${args.searchTerm}%`;

          const baseQuery = `
            SELECT
              vc.* from "VirtualCards" vc
              ${ifStr(args.merchantId, 'LEFT JOIN "Expenses" e ON e."VirtualCardId" = vc.id AND e."deletedAt" IS NULL')}
              ${ifStr(
                hasSpentFilter || hasExpensePeriodFilter,
                `
                LEFT JOIN LATERAL (
                  SELECT
                    ${ifStr(hasSpentFilter, 'sum(ce.amount) as sum')}
                    ${ifStr(!hasSpentFilter, 'count(1) as count')}
                  FROM "Expenses" ce
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ce."deletedAt" IS NULL
                  ${ifStr(!hasSpentFilter, 'LIMIT 1')}
                ) AS charges ON TRUE
              `,
              )}
              ${ifStr(
                !isNil(args.hasMissingReceipts),
                `
                LEFT JOIN LATERAL (
                  SELECT count(1) as total FROM "Expenses" ce
                  LEFT JOIN "ExpenseItems" ei on ei."ExpenseId" = ce.id
                  WHERE ce."VirtualCardId" = vc.id
                  ${ifStr(hasExpenseFromDate, 'AND ce."createdAt" >= :expensesFromDate')}
                  ${ifStr(hasExpenseToDate, 'AND ce."createdAt" <= :expensesToDate')}
                  AND ei.url IS NULL
                  AND ei."deletedAt" is NULL
                  AND ce."deletedAt" is NULL
                  LIMIT 1
                ) AS "lackingReceipts" ON TRUE
              `,
              )}
            WHERE
              vc."HostCollectiveId" = :hostCollectiveId
              AND vc."deletedAt" IS NULL
              ${ifStr(hasStatusFilter, `AND vc.data#>>'{status}' IN (:status)`)}
              ${ifStr(hasCollectiveFilter, `AND vc."CollectiveId" IN (:collectiveIds)`)}
              ${ifStr(hasMerchantFilter, 'AND e."CollectiveId" = :merchantId')}

              ${ifStr(
                hasExpensePeriodFilter && !hasSpentFilter,
                `
              -- filter by existence of expenses
                AND COALESCE(charges.count, 0) > 0
              `,
              )}

              ${ifStr(
                hasSpentFromFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) >= :spentAmountFrom
              `,
              )}
              ${ifStr(
                hasSpentToFilter,
                `
                -- filter by sum of expense amounts
                AND COALESCE(charges.sum, 0) <= :spentAmountTo
              `,
              )}

              ${ifStr(args.hasMissingReceipts === true, `AND COALESCE("lackingReceipts".total, 0) > 0`)}
              ${ifStr(args.hasMissingReceipts === false, `AND COALESCE("lackingReceipts".total, 0) = 0`)}

              ${ifStr(
                hasSearchTerm,
                `AND (
                vc.name ILIKE :searchTerm
                OR vc.data#>>'{last4}' ILIKE :searchTerm
              )`,
              )}
          `;

          const countQuery = `
            SELECT count(1) as total FROM (${baseQuery}) as base
          `;

          const pageQuery = `
                SELECT * FROM (${baseQuery}) as base
                ORDER BY "createdAt" ${args.orderBy.direction === 'DESC' ? 'DESC' : 'ASC'}
                LIMIT :limit
                OFFSET :offset
          `;

          let merchantId;
          if (!isEmpty(args.merchantAccount)) {
            merchantId = (
              await fetchAccountWithReference(args.merchantAccount, { throwIfMissing: true, loaders: req.loaders })
            ).id;
          }

          const collectiveIds = isEmpty(args.collectiveAccountIds)
            ? [null]
            : await Promise.all(
                args.collectiveAccountIds.map(collectiveAccountId =>
                  fetchAccountWithReference(collectiveAccountId, { throwIfMissing: true, loaders: req.loaders }),
                ),
              ).then(collectives => collectives.map(collective => collective.id));

          const statusArg = !args.status || args.status.length === 0 ? [null] : args.status;

          const queryReplacements = {
            hostCollectiveId: host.id,
            status: statusArg,
            collectiveIds: collectiveIds,
            merchantId: merchantId ?? null,
            expensesFromDate: args.withExpensesDateFrom ?? null,
            expensesToDate: args.withExpensesDateTo ?? null,
            spentAmountFrom: args.spentAmountFrom ? getValueInCentsFromAmountInput(args.spentAmountFrom) : null,
            spentAmountTo: args.spentAmountTo ? getValueInCentsFromAmountInput(args.spentAmountTo) : null,
            limit: args.limit,
            offset: args.offset,
            hasMissingReceipts: args.hasMissingReceipts ?? null,
            searchTerm: searchTerm,
          };

          const nodes = () =>
            sequelize.query(pageQuery, {
              replacements: queryReplacements,
              type: sequelize.QueryTypes.SELECT,
              model: models.VirtualCard,
            });

          const totalCount = () =>
            sequelize
              .query(countQuery, {
                plain: true,
                replacements: queryReplacements,
              })
              .then(result => result.total);

          return {
            nodes,
            totalCount,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardMerchants: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            where: {
              type: CollectiveType.VENDOR,
            },
            include: [
              {
                attributes: [],
                association: 'submittedExpenses',
                required: true,
                include: [
                  {
                    attributes: [],
                    association: 'virtualCard',
                    required: true,
                    where: {
                      HostCollectiveId: host.id,
                      data: { type: 'MERCHANT_LOCKED' },
                    },
                  },
                ],
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedVirtualCardCollectives: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        args: {
          limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
          offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            throw new Unauthorized('You need to be logged in as an admin to see the virtual card merchants');
          }

          const result = await models.Collective.findAndCountAll({
            group: 'Collective.id',
            include: [
              {
                attributes: [],
                association: 'virtualCardCollectives',
                required: true,
                where: {
                  HostCollectiveId: host.id,
                },
              },
            ],
          });

          return {
            nodes: result.rows,
            totalCount: result.count.length, // See https://github.com/sequelize/sequelize/issues/9109
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      contributionStats: {
        type: new GraphQLNonNull(GraphQLContributionStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the contribution stats should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate contribution statistics beginning from this date.',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate contribution statistics until this date.',
          },
          timeUnit: {
            type: GraphQLTimeUnit,
            description: 'The time unit of the time series',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or an accountant of the host to see the contribution stats.',
            );
          }
          const where: Parameters<typeof models.Transaction.findAll>[0]['where'] = {
            HostCollectiveId: host.id,
            kind: [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS],
            type: TransactionTypes.CREDIT,
            isRefund: false,
            RefundTransactionId: null,
          };
          const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
          const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
          if (dateRange) {
            where.createdAt = dateRange;
          }
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, {
              throwIfMissing: true,
              attributes: ['id'],
            });
            collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const contributionsCountPromise = models.Transaction.findAll({
            attributes: [
              [
                sequelize.literal(`CASE WHEN "Order"."interval" IS NOT NULL THEN 'recurring' ELSE 'one-time' END`),
                'label',
              ],
              [sequelize.literal(`COUNT(*)`), 'count'],
              [sequelize.literal(`COUNT(DISTINCT "Order"."id")`), 'countDistinct'],
              [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
            ],
            where,
            include: [{ model: models.Order, attributes: [] }],
            group: ['label'],
            raw: true,
          }) as unknown as Promise<
            Array<{
              label: 'one-time' | 'recurring';
              count: number;
              countDistinct: number;
              sumAmount: number;
            }>
          >;

          return {
            contributionsCount: contributionsCountPromise.then(results =>
              results.reduce((total, result) => total + result.count, 0),
            ),
            oneTimeContributionsCount: contributionsCountPromise.then(results =>
              results
                .filter(result => result.label === 'one-time')
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            recurringContributionsCount: contributionsCountPromise.then(results =>
              results
                .filter(result => result.label === 'recurring')
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            dailyAverageIncomeAmount: async () => {
              const contributionsAmountSum = await contributionsCountPromise.then(results =>
                results.reduce((total, result) => total + result.sumAmount, 0),
              );

              const dailyAverageIncomeAmount = contributionsAmountSum / numberOfDays;
              return {
                value: dailyAverageIncomeAmount || 0,
                currency: host.currency,
              };
            },
          };
        },
      },
      expenseStats: {
        type: new GraphQLNonNull(GraphQLExpenseStats),
        args: {
          account: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
            description: 'A collection of accounts for which the expense stats should be returned.',
          },
          dateFrom: {
            type: GraphQLDateTime,
            description: 'Calculate expense statistics beginning from this date.',
          },
          dateTo: {
            type: GraphQLDateTime,
            description: 'Calculate expense statistics until this date.',
          },
          timeUnit: {
            type: GraphQLTimeUnit,
            description:
              'The time unit of the time series (such as MONTH, YEAR, WEEK etc). If no value is provided this is calculated using the dateFrom and dateTo values.',
          },
        },
        async resolve(host, args, req) {
          if (!req.remoteUser?.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or an accountant of the host to see the expense stats.',
            );
          }
          const where: Parameters<typeof models.Transaction.findAll>[0]['where'] = {
            HostCollectiveId: host.id,
            kind: 'EXPENSE',
            type: TransactionTypes.DEBIT,
            isRefund: false,
            RefundTransactionId: null,
          };
          const numberOfDays = getNumberOfDays(args.dateFrom, args.dateTo, host) || 1;
          const dateRange = getFilterDateRange(args.dateFrom, args.dateTo);
          if (dateRange) {
            where.createdAt = dateRange;
          }
          let collectiveIds;
          if (args.account) {
            const collectives = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
            collectiveIds = collectives.map(collective => collective.id);
            where.CollectiveId = { [Op.in]: collectiveIds };
          }

          const expensesCountPromise = models.Transaction.findAll({
            attributes: [
              [sequelize.literal(`"Expense"."type"`), 'type'],
              [sequelize.literal(`COUNT(DISTINCT "Expense"."id")`), 'countDistinct'],
              [sequelize.literal(`COUNT(*)`), 'count'],
              [sequelize.literal(`SUM("Transaction"."amountInHostCurrency")`), 'sumAmount'],
            ],
            where,
            include: [{ model: models.Expense, attributes: [] }],
            group: ['Expense.type'],
            raw: true,
          }) as unknown as Promise<
            Array<{
              type: string;
              countDistinct: number;
              count: number;
              sumAmount: number;
            }>
          >;

          return {
            expensesCount: expensesCountPromise.then(results =>
              results.reduce((total, result) => total + result.countDistinct, 0),
            ),
            invoicesCount: expensesCountPromise.then(results =>
              results
                .filter(result => result.type === expenseType.INVOICE)
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            reimbursementsCount: expensesCountPromise.then(results =>
              results
                .filter(result => result.type === expenseType.RECEIPT)
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            grantsCount: expensesCountPromise.then(results =>
              results
                .filter(result => ([expenseType.FUNDING_REQUEST, expenseType.GRANT] as string[]).includes(result.type))
                .reduce((total, result) => total + result.countDistinct, 0),
            ),
            // NOTE: not supported here UNCLASSIFIED, SETTLEMENT, CHARGE
            dailyAverageAmount: async () => {
              const expensesAmountSum = await expensesCountPromise.then(results =>
                results.reduce((total, result) => total + result.sumAmount, 0),
              );

              const dailyAverageAmount = Math.abs(expensesAmountSum) / numberOfDays;
              return {
                value: dailyAverageAmount || 0,
                currency: host.currency,
              };
            },
          };
        },
      },
      isTrustedHost: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the host is trusted or not',
        resolve: account => get(account, 'data.isTrustedHost', false),
      },
      isFirstPartyHost: {
        type: new GraphQLNonNull(GraphQLBoolean),
        description: 'Returns whether the host is trusted or not',
        resolve: account => get(account, 'data.isFirstPartyHost', false),
      },
      hasDisputedOrders: {
        type: GraphQLBoolean,
        description: 'Returns whether the host has any Stripe disputed orders',
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          return Boolean(
            await models.Order.count({
              where: { status: OrderStatuses.DISPUTED },
              include: [
                {
                  model: models.Transaction,
                  required: true,
                  where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
                },
              ],
            }),
          );
        },
      },
      hasInReviewOrders: {
        type: GraphQLBoolean,
        description: 'Returns whether the host has any Stripe in review orders',
        async resolve(host, _, req) {
          if (!req.remoteUser?.isAdmin(host.id)) {
            return null;
          }

          return Boolean(
            await models.Order.count({
              where: { status: OrderStatuses.IN_REVIEW },
              include: [
                {
                  model: models.Transaction,
                  required: true,
                  where: { HostCollectiveId: host.id, kind: TransactionKind.CONTRIBUTION },
                },
              ],
            }),
          );
        },
      },
      hostedAccountAgreements: {
        type: new GraphQLNonNull(GraphQLAgreementCollection),
        description: 'Returns agreements with Hosted Accounts',
        args: {
          ...CollectionArgs,
          accounts: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Filter by accounts participating in the agreement',
          },
        },
        async resolve(host, args, req) {
          if (!Agreement.canSeeAgreementsForHostCollectiveId(req.remoteUser, host.id)) {
            throw new Unauthorized(
              'You need to be logged in as an admin or accountant of the host to see its agreements',
            );
          }

          const includeWhereArgs = {};

          if (args.accounts && args.accounts.length > 0) {
            const accounts = await fetchAccountsWithReferences(args.accounts, {
              throwIfMissing: true,
              attributes: ['id', 'ParentCollectiveId'],
            });

            const allIds = accounts.map(account => account.id);
            const allParentIds = accounts.map(account => account.ParentCollectiveId).filter(Boolean);
            includeWhereArgs['id'] = uniq([...allIds, ...allParentIds]);
          }

          const agreements = await Agreement.findAndCountAll({
            where: {
              HostCollectiveId: host.id,
            },
            include: [
              {
                model: Collective,
                as: 'Collective',
                required: true,
                where: includeWhereArgs,
              },
            ],
            limit: args.limit,
            offset: args.offset,
            order: [['createdAt', 'desc']],
          });

          return { totalCount: agreements.count, limit: args.limit, offset: args.offset, nodes: agreements.rows };
        },
      },
      vendors: {
        type: new GraphQLNonNull(GraphQLVendorCollection),
        description: 'Returns a list of vendors that works with this host',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
          forAccount: {
            type: GraphQLAccountReferenceInput,
            description: 'Rank vendors based on their relationship with this account',
          },
          visibleToAccounts: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Only returns vendors that are visible to the given accounts',
          },
          isArchived: {
            type: GraphQLBoolean,
            description: 'Filter on archived vendors',
          },
          searchTerm: {
            type: GraphQLString,
            description: 'Search vendors related to this term based on name, description, tags, slug, and location',
          },
        },
        async resolve(account, args, req) {
          const where = {
            ParentCollectiveId: account.id,
            type: CollectiveType.VENDOR,
            deactivatedAt: { [args.isArchived ? Op.not : Op.is]: null },
          };

          const publicVendorPolicy = await getPolicy(account, POLICIES.EXPENSE_PUBLIC_VENDORS);
          const isAdmin = req.remoteUser?.isAdminOfCollective(account);
          if (!publicVendorPolicy && !isAdmin) {
            return { nodes: [], totalCount: 0, limit: args.limit, offset: args.offset };
          }

          const searchTermConditions =
            args.searchTerm &&
            buildSearchConditions(args.searchTerm, {
              idFields: ['id'],
              slugFields: ['slug'],
              textFields: ['name', 'description', 'longDescription'],
              stringArrayFields: ['tags'],
              stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            });
          if (searchTermConditions?.length) {
            where[Op.or] = searchTermConditions;
          }

          // @ts-expect-error Property 'group' is missing => It's an error on sequelize types, as the [docs](https://sequelize.org/docs/v6/core-concepts/model-querying-finders/#findandcountall) clearly say it's opitonal
          const findArgs: Parameters<typeof models.Collective.findAndCountAll>[0] = {
            where,
            limit: args.limit,
            offset: args.offset,
            order: [['createdAt', 'DESC']],
          };

          if (args.forAccount) {
            const account = await fetchAccountWithReference(args.forAccount);
            findArgs['attributes'] = {
              include: [
                [
                  sequelize.literal(`(
            SELECT COUNT(*) FROM "Expenses" WHERE "deletedAt" IS NULL AND "status" = 'PAID' AND "CollectiveId" = ${account.id} AND "FromCollectiveId" = "Collective"."id"
          )`),
                  'expenseCount',
                ],
              ],
            };
            findArgs.order = [
              [sequelize.literal('"expenseCount"'), 'DESC'],
              ['createdAt', 'DESC'],
            ];
          }

          if (args.visibleToAccounts?.length > 0) {
            const visibleToAccountIds = await fetchAccountsIdsWithReference(args.visibleToAccounts, {
              throwIfMissing: true,
            });
            findArgs.where[Op.and] = [
              sequelize.literal(`
                    data#>'{visibleToAccountIds}' IS NULL 
                    OR data#>'{visibleToAccountIds}' = '[]'::jsonb
                    OR data#>'{visibleToAccountIds}' = 'null'::jsonb
                    OR
                    (
                      jsonb_typeof(data#>'{visibleToAccountIds}')='array'
                      AND 
                      EXISTS (
                        SELECT v FROM (
                          SELECT v::text::int FROM (SELECT jsonb_array_elements(data#>'{visibleToAccountIds}') as v)
                        ) WHERE v = ANY(${sequelize.escape(visibleToAccountIds)})
                      )  
                    )
              `),
            ];
          }
          const { rows, count } = await models.Collective.findAndCountAll(findArgs);
          const vendors = args.forAccount && !isAdmin ? rows.filter(v => v.dataValues['expenseCount'] > 0) : rows;

          return { nodes: vendors, totalCount: count, limit: args.limit, offset: args.offset };
        },
      },
      potentialVendors: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        description:
          'Returns a list of organizations that only transacted with this host and all its admins are also admins of this host.',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
        },
        async resolve(host, args, req) {
          const isAdmin = req.remoteUser.isAdminOfCollective(host);
          if (!isAdmin) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its potential vendors');
          }

          const pageQuery = `
                WITH hostadmins AS (
                  SELECT m."MemberCollectiveId", u."id" as "UserId"
                  FROM "Members" m
                  INNER JOIN "Users" u ON m."MemberCollectiveId" = u."CollectiveId"
                  WHERE m."CollectiveId" = :hostid AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
                  ), orgs AS (
                  SELECT c.id, c.slug,ARRAY_AGG(DISTINCT m."MemberCollectiveId") as "admins", ARRAY_AGG(DISTINCT t."HostCollectiveId") as hosts, c."CreatedByUserId"
                  FROM "Collectives" c
                  LEFT JOIN "Members" m ON c.id = m."CollectiveId" AND m."deletedAt" IS NULL AND m.role = 'ADMIN'
                  LEFT JOIN "Transactions" t ON c.id = t."FromCollectiveId" AND t."deletedAt" IS NULL
                  WHERE c."deletedAt" IS NULL
                    AND c.type = 'ORGANIZATION'
                    AND c."HostCollectiveId" IS NULL
                  GROUP BY c.id
                  )

                SELECT c.*
                FROM "orgs" o
                INNER JOIN "Collectives" c ON c.id = o.id
                WHERE
                  (
                    o."admins" <@ ARRAY(SELECT "MemberCollectiveId" FROM hostadmins)
                      OR (
                        o."CreatedByUserId" IN (
                        SELECT "UserId"
                        FROM hostadmins
                        )
                        AND o."admins" = ARRAY[null]::INTEGER[]
                      )
                    )
                  AND o."hosts" IN (ARRAY[:hostid], ARRAY[null]::INTEGER[])
                ORDER BY c."createdAt" DESC
                LIMIT :limit
                OFFSET :offset;
          `;

          const orgs = await sequelize.query(pageQuery, {
            replacements: {
              hostid: host.id,
              limit: args.limit,
              offset: args.offset,
            },
            type: sequelize.QueryTypes.SELECT,
            model: models.Collective,
          });

          return {
            nodes: orgs,
            totalCount: orgs.length,
            limit: args.limit,
            offset: args.offset,
          };
        },
      },
      hostedAccounts: {
        type: new GraphQLNonNull(GraphQLHostedAccountCollection),
        description: 'Returns a list of accounts hosted by this host',
        args: {
          ...getCollectionArgs({ limit: 100, offset: 0 }),
          accountType: { type: new GraphQLList(GraphQLAccountType) },
          isApproved: {
            type: GraphQLBoolean,
            description: 'Filter on (un)approved collectives',
            defaultValue: true,
          },
          isFrozen: {
            type: GraphQLBoolean,
            description: 'Filter on frozen accounts',
          },
          isUnhosted: {
            type: GraphQLBoolean,
            description: 'Filter on unhosted accounts',
            defaultValue: false,
          },
          hostFeesStructure: {
            type: GraphQLHostFeeStructure,
            description: 'Filters on the Host fees structure applied to this account',
          },
          searchTerm: {
            type: GraphQLString,
            description:
              'A term to search membership. Searches in collective tags, name, slug, members description and role.',
          },
          orderBy: {
            type: GraphQLOrderByInput,
            description: 'Order of the results',
          },
          balance: {
            type: GraphQLAmountRangeInput,
            description: 'Filter by the balance of the account',
          },
          consolidatedBalance: {
            type: GraphQLAmountRangeInput,
            description: 'Filter by the balance of the account and its children accounts (events and projects)',
          },
          currencies: {
            type: new GraphQLList(GraphQLString),
            description: 'Filter by specific Account currencies',
          },
        },
        async resolve(host, args) {
          const where: Parameters<typeof models.Collective.findAndCountAll>[0]['where'] = {
            HostCollectiveId: host.id,
            id: { [Op.not]: host.id },
          };

          if (args.accountType && args.accountType.length > 0) {
            where.type = {
              [Op.in]: args.accountType.map(value => AccountTypeToModelMapping[value]),
            };
          }

          if (args.currencies && args.currencies.length > 0) {
            where.currency = {
              [Op.in]: args.currencies,
            };
          }

          if (!isNil(args.isFrozen)) {
            if (args.isFrozen) {
              set(where, `data.features.${FEATURE.ALL}`, false);
            } else {
              set(where, `data.features.${FEATURE.ALL}`, { [Op.is]: null });
            }
          }

          if (args.hostFeesStructure) {
            if (args.hostFeesStructure === HOST_FEE_STRUCTURE.DEFAULT) {
              where.data = { useCustomHostFee: { [Op.not]: true } };
            } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.CUSTOM_FEE) {
              where.data = { useCustomHostFee: true };
            } else if (args.hostFeesStructure === HOST_FEE_STRUCTURE.MONTHLY_RETAINER) {
              throw new ValidationFailed('The MONTHLY_RETAINER fees structure is not supported yet');
            }
          }

          if (!isEmpty(args.balance)) {
            if (args.balance.gte?.currency) {
              assert(args.balance.gte.currency === host.currency, 'Balance currency must match host currency');
            }

            if (args.balance.lte?.currency) {
              assert(args.balance.lte.currency === host.currency, 'Balance currency must match host currency');
            }

            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            if (!where[Op.and]) {
              // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
              where[Op.and] = [];
            }

            const { operator, value } = getAmountRangeValueAndOperator(args.balance);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push(sequelize.where(ACCOUNT_BALANCE_QUERY, operator, value));
          }

          if (!isEmpty(args.consolidatedBalance)) {
            if (args.consolidatedBalance.gte?.currency) {
              assert(
                args.consolidatedBalance.gte.currency === host.currency,
                'Consolidated Balance currency must match host currency',
              );
            }

            if (args.consolidatedBalance.lte?.currency) {
              assert(
                args.consolidatedBalance.lte.currency === host.currency,
                'Consolidated Balance currency must match host currency',
              );
            }

            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            if (!where[Op.and]) {
              // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
              where[Op.and] = [];
            }

            const { operator, value } = getAmountRangeValueAndOperator(args.consolidatedBalance);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push(sequelize.where(ACCOUNT_CONSOLIDATED_BALANCE_QUERY, operator, value));
          }

          if (args.isUnhosted) {
            const collectiveIds = await models.HostApplication.findAll({
              attributes: ['CollectiveId'],
              where: { HostCollectiveId: host.id, status: 'APPROVED' },
            });
            where.HostCollectiveId = { [Op.or]: [{ [Op.ne]: host.id }, { [Op.is]: null }] };
            const id = collectiveIds.map(({ CollectiveId }) => CollectiveId);
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            if (!where[Op.and]) {
              // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
              where[Op.and] = [];
            }
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.and].push({ [Op.or]: [{ id: id }, { ParentCollectiveId: id }] });
          } else {
            where.isActive = true;
            where.approvedAt = args.isApproved ? { [Op.not]: null } : null;
          }

          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id'],
            slugFields: ['slug'],
            textFields: ['name', 'description'],
            stringArrayFields: ['tags'],
            stringArrayTransformFn: str => str.toLowerCase(), // collective tags are stored lowercase
            castStringArraysToVarchar: true,
          });

          if (searchTermConditions.length) {
            // @ts-expect-error Type 'unique symbol' cannot be used as an index type. Not sure why TS is not happy here.
            where[Op.or] = searchTermConditions;
          }

          const orderBy = [];
          if (args.orderBy) {
            const { field, direction } = args.orderBy;
            if (field === ORDER_BY_PSEUDO_FIELDS.CREATED_AT) {
              // Quick hack here, using ApprovedAt because in this context,
              // it doesn't make sense to order by createdAt and this ends
              // up saving a whole new component that needs to be implemented
              orderBy.push(['approvedAt', direction]);
            } else if (field === ORDER_BY_PSEUDO_FIELDS.BALANCE) {
              orderBy.push([ACCOUNT_CONSOLIDATED_BALANCE_QUERY, direction]);
            } else if (field === ORDER_BY_PSEUDO_FIELDS.UNHOSTED_AT) {
              orderBy.push([
                sequelize.literal(
                  `(SELECT "Activities"."createdAt" FROM "Activities" WHERE "CollectiveId" = "Collective"."id" AND "Activities"."HostCollectiveId" = ${host.id} AND "Activities"."type" = '${ActivityTypes.COLLECTIVE_UNHOSTED}' ORDER BY "Activities"."id" DESC LIMIT 1)`,
                ),
                direction,
              ]);
            } else {
              orderBy.push([field, direction]);
            }
          } else {
            orderBy.push(['approvedAt', 'DESC']);
          }

          const result = await models.Collective.findAndCountAll({
            limit: args.limit,
            offset: args.offset,
            order: orderBy,
            where,
          });

          return {
            nodes: result.rows,
            totalCount: result.count,
            limit: args.limit,
            offset: args.offset,
            currencies: () =>
              models.Collective.findAll({
                where,
                attributes: [[sequelize.fn('DISTINCT', sequelize.col('currency')), 'currency']],
              }).then(collectives => collectives.map(c => c.currency)),
          };
        },
      },
      requiredLegalDocuments: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLLegalDocumentType))),
        description: 'Returns the legal documents required by this host',
        async resolve(host) {
          const documents = await models.RequiredLegalDocument.findAll({
            attributes: ['documentType'],
            where: { HostCollectiveId: host.id },
            raw: true,
          });

          return documents.map(({ documentType }) => documentType);
        },
      },
      hostedLegalDocuments: {
        type: new GraphQLNonNull(GraphQLLegalDocumentCollection),
        description: 'Returns legal documents hosted by this host',
        args: {
          ...CollectionArgs,
          type: {
            type: new GraphQLList(GraphQLLegalDocumentType),
            description: 'Filter by type of legal document',
          },
          status: {
            type: new GraphQLList(GraphQLLegalDocumentRequestStatus),
            description: 'Filter by status of legal document',
          },
          account: {
            type: new GraphQLList(GraphQLAccountReferenceInput),
            description: 'Filter by accounts',
          },
          searchTerm: {
            type: GraphQLString,
            description: 'Search term (name, description, ...)',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            description: 'The order of results',
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
          },
          requestedAtFrom: {
            type: GraphQLDateTime,
            description: 'Filter by requested date from',
          },
          requestedAtTo: {
            type: GraphQLDateTime,
            description: 'Filter by requested date to',
          },
        },
        resolve: async (host, args, req) => {
          checkRemoteUserCanUseHost(req);
          if (!req.remoteUser.isAdminOfCollective(host)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its legal documents');
          }

          if (args.type.length > 1 || args.type[0] !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
            throw new Error('Only US_TAX_FORM is supported for now');
          }

          const { offset, limit } = args;
          const accountIds = await SQLQueries.getTaxFormsRequiredForAccounts({
            HostCollectiveId: host.id,
            allTime: true,
          });
          if (!accountIds.size) {
            return { nodes: [], totalCount: 0, limit, offset };
          }

          const where = { CollectiveId: Array.from(accountIds) };
          if (args.type) {
            where['documentType'] = args.type;
          }
          if (args.status) {
            where['requestStatus'] = args.status;
          }

          if (args.accounts && args.accounts.length > 0) {
            const accountIds = await fetchAccountsIdsWithReference(args.accounts, { throwIfMissing: true });
            where['CollectiveId'] = uniq([...where['CollectiveId'], ...accountIds]);
          }

          if (args.requestedAtFrom) {
            where['createdAt'] = { [Op.gte]: args.requestedAtFrom };
          }
          if (args.requestedAtTo) {
            where['createdAt'] = { ...where['createdAt'], [Op.lte]: args.requestedAtTo };
          }

          const include = [];

          // Add support for text search
          const searchTermConditions = buildSearchConditions(args.searchTerm, {
            idFields: ['id', 'CollectiveId'],
            slugFields: ['$collective.slug$'],
            textFields: ['$collective.name$'],
          });

          if (searchTermConditions.length) {
            where[Op.or] = searchTermConditions;
            include.push({ association: 'collective', required: true });
          }

          return {
            totalCount: () => models.LegalDocument.count({ where, include }),
            nodes: () =>
              models.LegalDocument.findAll({
                where,
                offset,
                include,
                limit,
                order: [
                  [args.orderBy.field, args.orderBy.direction],
                  ['id', 'DESC'],
                ],
              }),
            limit,
            offset,
          };
        },
      },
      transactionsImports: {
        type: new GraphQLNonNull(GraphQLTransactionsImportsCollection),
        description: 'Returns a list of transactions imports for this host',
        args: {
          ...CollectionArgs,
          status: {
            type: GraphQLTransactionsImportStatus,
            description: 'Filter by status of transactions import',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
            description: 'The order of results',
            defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
          },
          type: {
            type: new GraphQLList(GraphQLTransactionsImportType),
            description: 'Filter by type of transactions import',
          },
        },
        async resolve(host, args, req) {
          checkRemoteUserCanUseTransactions(req);
          if (!req.remoteUser.isAdminOfCollective(host)) {
            throw new Unauthorized('You need to be logged in as an admin of the host to see its transactions imports');
          }

          const where: Parameters<typeof models.TransactionsImport.findAll>[0]['where'] = { CollectiveId: host.id };

          if (args.status) {
            if (args.status === 'ACTIVE') {
              where['ConnectedAccountId'] = { [Op.not]: null };
            } else {
              where['ConnectedAccountId'] = null;
            }
          }

          if (args.type) {
            where['type'] = args.type;
          }

          return {
            limit: args.limit,
            offset: args.offset,
            totalCount: () => models.TransactionsImport.count({ where }),
            nodes: () =>
              models.TransactionsImport.findAll({
                where,
                limit: args.limit,
                offset: args.offset,
                order: [[args.orderBy.field, args.orderBy.direction]],
              }),
          };
        },
      },
      transactionsImportsSources: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLNonEmptyString)),
        description: 'Returns a list of transactions imports sources for this host',
        args: {
          type: {
            type: new GraphQLList(GraphQLTransactionsImportType),
            description: 'Filter by type of transactions import',
          },
        },
        async resolve(host: Collective, args, req: express.Request) {
          checkRemoteUserCanUseHost(req);
          if (!req.remoteUser.isAdminOfCollective(host)) {
            throw new Unauthorized(
              'You need to be logged in as an admin of the host to see its transactions imports sources',
            );
          }

          const where: Parameters<typeof models.TransactionsImport.findAll>[0]['where'] = {
            CollectiveId: host.id,
            ...(args.type && { type: args.type }),
          };

          return models.TransactionsImport.aggregate('source', 'DISTINCT', {
            plain: false,
            where,
          }).then((results: { DISTINCT: string }[]) => {
            return results.map(({ DISTINCT }) => DISTINCT);
          });
        },
      },
      offPlatformTransactions: {
        type: new GraphQLNonNull(GraphQLTransactionsImportRowCollection),
        args: {
          ...getCollectionArgs({ limit: 100 }),
          status: {
            type: GraphQLTransactionsImportRowStatus,
            description: 'Filter rows by status',
          },
          searchTerm: {
            type: GraphQLString,
            description: 'Search by text',
          },
          accountId: {
            type: new GraphQLList(GraphQLNonEmptyString),
            description: 'Filter rows by plaid account id',
          },
          importId: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLNonEmptyString)),
            description: 'The transactions import id(s)',
          },
          importType: {
            type: new GraphQLList(new GraphQLNonNull(GraphQLTransactionsImportType)),
            description: 'Filter rows by import type',
          },
          orderBy: {
            type: new GraphQLNonNull(GraphQLTransactionsImportRowOrderInput),
            description: 'The order of results',
            defaultValue: { field: 'date', direction: 'DESC' },
          },
        },
        async resolve(
          host,
          args: {
            limit: number;
            offset: number;
            status: TransactionsImportRowStatus;
            searchTerm: string;
            accountId: string[];
            importId: string[];
            importType: string[];
            orderBy: { field: 'date'; direction: 'ASC' | 'DESC' };
          },
          req,
        ) {
          if (!req.remoteUser?.isAdminOfCollective(host)) {
            throw new Unauthorized(
              'You need to be logged in as an admin of the host to see its off platform transactions',
            );
          }

          checkRemoteUserCanUseTransactions(req);

          // This include is about:
          // 1. Security: making sure we only return transactions import rows for the host.
          // 2. Performance: the index on `TransactionsImports.CollectiveId` is used to filter the rows.
          const include: Parameters<typeof TransactionsImportRow.findAll>[0]['include'] = [
            {
              association: 'import',
              required: true,
              where: {
                ...((args.importType && { type: args.importType }) || {}),
                ...((args.importId && { id: args.importId.map(id => idDecode(id, 'transactions-import')) }) || {}),
                CollectiveId: host.id,
              },
            },
          ];

          const where: Parameters<typeof TransactionsImportRow.findAll>[0]['where'] = [];

          // Filter by status
          if (args.status) {
            where.push({ status: args.status });
          }

          // Search term
          if (args.searchTerm) {
            where.push({
              [Op.or]: buildSearchConditions(args.searchTerm, {
                textFields: ['description', 'sourceId'],
              }),
            });
          }

          // Filter by plaid account id
          if (args.accountId?.length) {
            // eslint-disable-next-line camelcase
            where.push({ rawValue: { account_id: { [Op.in]: args.accountId } } });
          }

          return {
            offset: args.offset,
            limit: args.limit,
            totalCount: () => TransactionsImportRow.count({ where, include }),
            nodes: () =>
              TransactionsImportRow.findAll({
                where,
                include,
                limit: args.limit,
                offset: args.offset,
                order: [
                  [args.orderBy.field, args.orderBy.direction],
                  ['id', args.orderBy.direction],
                ],
              }),
          };
        },
      },
      offPlatformTransactionsStats: {
        type: new GraphQLNonNull(GraphQLTransactionsImportStats),
        description: 'Returns stats for off platform transactions',
        async resolve(host, args, req) {
          if (!req.remoteUser?.isAdminOfCollective(host)) {
            throw new Unauthorized(
              'You need to be logged in as an admin of the host to see its off platform transactions',
            );
          }

          checkRemoteUserCanUseTransactions(req);
          return req.loaders.TransactionsImport.hostStats.load(host.id);
        },
      },
    };
  },
});
