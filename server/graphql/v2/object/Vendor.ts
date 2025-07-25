import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { CollectiveType } from '../../../constants/collectives';
import Collective from '../../../models/Collective';
import { AccountFields, GraphQLAccount } from '../interface/Account';
import { AccountWithContributionsFields, GraphQLAccountWithContributions } from '../interface/AccountWithContributions';

const GraphQLVendorContact = new GraphQLObjectType({
  name: 'VendorContact',
  description: 'Some context about the vendor contact person',
  fields: () => ({
    name: {
      type: GraphQLString,
    },
    email: {
      type: GraphQLString,
    },
  }),
});

const GraphQLVendorInfo = new GraphQLObjectType({
  name: 'VendorInfo',
  description: 'Some context about the vendor',
  fields: () => ({
    contact: { type: GraphQLVendorContact },
    taxFormUrl: { type: GraphQLString },
    taxFormRequired: { type: GraphQLBoolean },
    taxType: { type: GraphQLString },
    taxId: { type: GraphQLString },
    notes: { type: GraphQLString },
  }),
});

export const GraphQLVendor = new GraphQLObjectType({
  name: 'Vendor',
  description: 'This represents a Vendor account',
  interfaces: () => [GraphQLAccount, GraphQLAccountWithContributions],
  isTypeOf: collective => collective.type === CollectiveType.VENDOR,
  fields: () => {
    return {
      ...AccountFields,
      ...AccountWithContributionsFields,
      vendorInfo: {
        type: GraphQLVendorInfo,
        resolve(collective, _, req) {
          if (req.remoteUser?.isAdmin(collective.ParentCollectiveId)) {
            return collective.data?.vendorInfo || {};
          }
        },
      },
      hasPayoutMethod: {
        type: GraphQLBoolean,
        description: 'Returns whether this account has any payout methods saved',
        async resolve(collective, _, req) {
          const payoutMethods = await req.loaders.PayoutMethod.byCollectiveId.load(collective.id);
          return payoutMethods.length > 0;
        },
      },
      createdByAccount: {
        type: GraphQLAccount,
        description: 'The account who created this order',
        async resolve(collective, _, req) {
          if (!collective.CreatedByUserId) {
            return null;
          }

          if (req.remoteUser?.isAdmin(collective.ParentCollectiveId)) {
            const user = await req.loaders.User.byId.load(collective.CreatedByUserId);
            if (user && user.CollectiveId) {
              const collective = await req.loaders.Collective.byId.load(user.CollectiveId);
              if (collective && !collective.isIncognito) {
                return collective;
              }
            }
          }
        },
      },
      visibleToAccounts: {
        type: new GraphQLNonNull(new GraphQLList(GraphQLAccount)),
        description:
          'The accounts where this vendor is visible, if empty or null applies to all collectives under the vendor host',
        async resolve(vendor: Collective, _, req) {
          const visibleToAccountIds = vendor.data?.visibleToAccountIds || [];

          if (visibleToAccountIds.length === 0) {
            return [];
          }

          return req.loaders.Collective.byId.loadMany(visibleToAccountIds);
        },
      },
      location: {
        ...AccountFields.location,
        async resolve(vendor, _, req) {
          // Vendors locations are always public
          if (req.remoteUser?.isAdmin(vendor.ParentCollectiveId)) {
            return req.loaders.Location.byCollectiveId.load(vendor.id);
          }
        },
      },
    };
  },
});
