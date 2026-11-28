# In-app products

`kit iap` keeps in-app products, subscriptions and RevenueCat offerings as code: one JSON file in the
repo is the source of truth for App Store Connect, Google Play and RevenueCat. `sync` creates what is missing and updates what differs;
it never deletes. `status` reports drift, `check` validates the file offline.

```sh
kit iap check                         # offline: schema, store limits, ids, screenshots (CI gate)
kit iap status                        # compare with every configured store; writes nothing
kit iap sync --dry-run                # the plan, nothing applied
kit iap sync                          # the plan, a confirmation, then the writes
kit iap sync --store play --yes       # one store, no question (CI)
kit iap status --product membership_card --json
kit iap sync --allow-price-change      # also apply changed subscription prices (new subscribers)
```

`--store apple|play|revenuecat` and `--product <id>` repeat; the default is every configured store
and everything in the file. `--product` takes product, subscription and offering ids. `kit check` runs `kit iap check` when `iap` is configured.

kit iap is built against each store's documentation and tested against stateful fakes of all three.
Subscriptions and offerings have not been run against a real account yet: run `sync --dry-run` and
read the plan before the first real sync, and set `KIT_IAP_RECORD` (below) for that run.

## Config

```ts
iap: {
  products: 'contract/products.json',        // repo-relative
  apple: { familySharing: true },             // bundleId defaults to release.ios.bundleIds[0]
  play: {},                                   // packageName defaults to release.android.packageName
  revenuecat: { projectId: 'projd2d1fc4a' },  // key from REVENUECAT_API_KEY; testStore: true adds the Test Store
},
```

A store takes part only when its key is present. See [`iap` in the config reference](CONFIG.md#iap).

## The product file

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@jordond/kit@0.12/schemas/iap.schema.json",
  "locale": "en-US",
  "products": [
    {
      "id": "membership_card",
      "type": "non_consumable",
      "name": "Membership Card",
      "description": "Unlimited shelf, 1080p, no watermark.",
      "price": "4.99",
      "priceChanges": [{ "from": "2027-02-01", "price": "7.99" }],
      "entitlement": "membership",
      "localizations": { "fr-FR": { "name": "Carte de membre", "description": "Étagère illimitée." } },
      "apple": {
        "reviewNote": "One-time unlock of the full shelf.",
        "reviewScreenshot": "contract/review/membership_card.png",
        "familySharable": true
      },
      "play": { "purchaseOptionId": "buy" }
    }
  ]
}
```

The JSON schema ships with kit (`schemas/iap.schema.json`); `$schema` points editors at it. The URL
carries your kit's major.minor (`@0.12` above is an example): `check` warns when `$schema` is missing
or names another kit version, and prints the exact URL to use. `kit upgrade` moves it with the pin.

| Field                                                      | App Store Connect                                                          | Google Play                                       | RevenueCat                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `id`                                                       | product id                                                                 | product id                                        | store identifier (both apps)                            |
| `type`                                                     | `NON_CONSUMABLE` / `CONSUMABLE`                                            | nothing (consuming is the app's call)             | `non_consumable` / `consumable`                         |
| `name`                                                     | display name (default locale); reference name unless `apple.referenceName` | listing title                                     | product display name                                    |
| `description`                                              | description (default locale)                                               | listing description                               |                                                         |
| `price`                                                    | USA price; Apple fills the other storefronts                               | US price; the other regions are converted by Play |                                                         |
| `priceChanges`                                             | dated prices in the price schedule                                         | applied by the first sync on or after the date    |                                                         |
| `entitlement` (default `id`)                               |                                                                            |                                                   | entitlement lookup key; the products are attached to it |
| `localizations`                                            | one localization per locale                                                | one listing per language                          |                                                         |
| `apple.reviewNote`, `apple.reviewScreenshot`               | App Review note and screenshot                                             |                                                   |                                                         |
| `apple.familySharable` (default `iap.apple.familySharing`) | Family Sharing (non-consumables only)                                      |                                                   |                                                         |
| `play.purchaseOptionId` (default `buy`)                    |                                                                            | the one buy option, backwards compatible          |                                                         |

Ids are permanent: neither store lets a deleted product id be used again, and `sync` never renames.

### Subscriptions

```json
"subscriptions": [
  {
    "id": "pro",
    "name": "Pro",
    "description": "Everything, every month.",
    "benefits": ["No ads", "Cloud sync"],
    "entitlement": "pro",
    "plans": [
      { "id": "yearly", "period": "P1Y", "price": "29.99", "trial": "P1W" },
      { "id": "monthly", "period": "P1M", "price": "3.99" }
    ],
    "apple": { "groupName": "Pro", "reviewNote": "…", "reviewScreenshot": "contract/review/pro.png" }
  }
]
```

| Field                              | App Store Connect                                                 | Google Play                                    | RevenueCat                               |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| `id`                               | subscription group reference name                                 | subscription id                                |                                          |
| `name`, `description`              | each plan's localization; reference name `Pro (yearly)`           | listing title and description                  | product display name `Pro (yearly)`      |
| `benefits` (up to 4)               |                                                                   | listing benefits                               |                                          |
| `entitlement` (default `id`)       |                                                                   |                                                | every plan's products are attached to it |
| `plans[].id`                       |                                                                   | base plan id                                   | Play store identifier `pro:yearly`       |
| `plans[].appleProductId`           | product id (default `pro_yearly`: `<id>_<plan>`, `-` becomes `_`) |                                                | App Store store identifier               |
| `plans[].period`                   | `P1W P1M P2M P3M P6M P1Y`; cannot change after create             | billing period; cannot change after create     |                                          |
| `plans[].price`                    | USA price; the other storefronts from Apple's equalized prices    | US price; other regions converted by Play      |                                          |
| `plans[].trial`                    | free trial introductory offer (`P3D` to `P1Y`)                    | offer `free-trial` on the base plan            |                                          |
| plan order                         | group level: the first plan is the highest                        | the first plan is the backwards-compatible one |                                          |
| `apple.groupName` (default `name`) | the group's display name                                          |                                                |                                          |

Prices are set when a plan is created. A changed price on an existing plan shows as
`differs (monthly: price)` and is applied only with `sync --allow-price-change`, for new subscribers:
Apple keeps existing subscribers on their price (a decrease reaches them too: Apple cannot preserve
it), and kit never calls Play's price migration. A trial is created only on a plan that has none; a
trial that differs is reported, never replaced (offers cannot be edited, and kit never deletes).

### Offerings

```json
"offerings": [
  {
    "id": "default",
    "current": true,
    "packages": [
      { "id": "$rc_annual", "product": "pro:yearly" },
      { "id": "$rc_monthly", "product": "pro:monthly" },
      { "id": "lifetime", "name": "Lifetime", "product": "membership_card" }
    ]
  }
]
```

RevenueCat only. `id` is the offering's lookup key and each package `id` the package's (both
permanent). `product` is a product id or `subscription:plan`; the package gets that product's App
Store and Play products. Packages show in array order; a package `name` defaults to the product's,
an offering `name` to its `id`. `current: true` (at most one) makes kit set it as the current offering.
A package that holds another product is reported, not changed.

### What `check` enforces

| Rule                             | Limit                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| product id                       | `^[a-z0-9][a-z0-9_.]*$`, at most 100 (subscription id 40)                                              |
| `play.purchaseOptionId`, plan id | `^[a-z0-9][a-z0-9-]*$`, at most 63                                                                     |
| Apple product id of a plan       | `[A-Za-z0-9._-]`, at most 100                                                                          |
| ids                              | unique across products, subscriptions and plans' Apple ids                                             |
| `name`                           | 2 to 30 characters (Apple's display name; Play allows 55)                                              |
| `apple.referenceName`            | at most 64                                                                                             |
| `description`                    | at most 45 (Apple; Play allows 200, subscriptions 80)                                                  |
| `apple.reviewNote`               | at most 4000                                                                                           |
| `price`                          | `"4.99"`: two decimals, more than 0                                                                    |
| `priceChanges`                   | real dates, increasing, at most the end of next year; one that has passed warns (move it into `price`) |
| `apple.reviewScreenshot`         | exists, PNG or JPEG, no alpha channel                                                                  |
| locales                          | BCP-47 (`fr-FR`); the default locale is not repeated in `localizations`                                |
| benefits                         | at most 4, 40 characters each                                                                          |
| offerings                        | unique ids, no spaces; one `current`; each package `product` is in the file                            |

Whether a price is one of Apple's price points needs the network: `sync --dry-run` checks it and fails
that product when it is not.

## What `sync` does per store

**App Store Connect.** Creates the in-app purchase (reference name, type, review note, Family Sharing),
then its localizations on the version in Prepare for Submission (made when there is none, which is how
App Store Connect takes edited text for review), the full price schedule (the current price and every
dated change still ahead, USA as the base), availability in every territory and new ones, and the
review screenshot. An existing product gets only what differs. `type` cannot change; Family Sharing
cannot be turned off; a review screenshot that differs is reported, not replaced (kit never deletes:
delete it in App Store Connect and sync again).

**Google Play.** One `onetimeproducts` PATCH per product creates or updates it with the listings and one
buy option (`legacyCompatible: true`, which RevenueCat and older billing libraries read). On create and
when the US price changes, Play's `convertRegionPrices` sets every other region; listing-only changes
send the regional prices back as Play has them. "In sync" compares the listings, the buy option and the
US price only, since converted prices move with exchange rates. A new (draft) purchase option is activated;
one turned off in Play Console is left off and noted. Other purchase options and listings in other languages are kept.

**App Store Connect subscriptions.** Creates the subscription group (and its localization), then per
plan the subscription (reference name, product id, period, group level, Family Sharing, review note),
its localizations, availability in every territory, the USA price with Apple's equalized price for
every other territory, the free trial in every territory, and the review screenshot. A product id
already used in another group, a changed period or Family Sharing turned off fail that subscription.
The first subscription ships with an app version, like the first one-time product.

**Google Play subscriptions.** One `subscriptions` PATCH per subscription with the listings (title,
description, benefits) and one auto-renewing base plan per file plan, priced from the US price by
`convertRegionPrices`. Draft base plans are activated; an inactive one is left alone (someone turned it
off) and noted. The trial is the `free-trial` offer, created and activated. Base plans and offers not
in the file are kept.

**RevenueCat.** Needs the App Store and Play Store apps already connected in the project (matched by
bundle id and package name). Creates a product per app with the product id as store identifier
(subscriptions: the Apple product id and `subscription:plan`), the entitlement, and attaches the
products to it. A changed name is updated; a changed type or an archived product or entitlement fails
that product with what to do in RevenueCat. Then the offerings: creates or renames them, creates
packages, sets their position and name, attaches each package's products, and sets the current
offering. RevenueCat runs after the two stores, so the products it points at exist.

**RevenueCat Test Store** (opt-in: `iap.revenuecat.testStore: true`, default false; off makes no Test
Store rows or requests). RevenueCat makes one Test Store app per project; the API cannot create it, so
without one kit reports an error for the Test Store ("add one under Apps & providers in RevenueCat")
and the rest of the sync still runs. With it, every one-time product and every subscription plan gets
a Test Store product, matched, renamed and type-checked like the App Store and Play Store ones, and
attached to the same entitlements and offering packages. One-time products use the product id, the
file's type and the product name as the `title` (default locale). Plans use the plan's Apple product id,
type `subscription` and `subscription.duration` from the plan period: `P1W`, `P1M`, `P2M`, `P3M`,
`P6M` or `P1Y` (a period the Test Store lacks fails that plan only). Trials cannot be set.

**Test Store prices are not set by kit.** The RevenueCat API takes no price for a Test Store product
and cannot edit one later, so the plan line says `price: set it in RevenueCat; the API takes none`.
If RevenueCat refuses a create without a price, that product fails with RevenueCat's message and the
others carry on; the product's Test Store attach is skipped.

`status` prints, per product per store: `missing`, `in sync`, `differs (fields)` or `extra` (in the
store, not in the file), the store's state (Apple's IAP and version state, Play's purchase option state,
RevenueCat's attachment), and notes. It exits 0 when things differ; `--json` gives
`{ stores: { apple: { label, rows, actions, skipped?, error? }, … }, ok }`. `sync --json` adds
`results: [{ id, kind, ok, skipped?, error? }]` per store.

A store without credentials is skipped with a warning while the others run. When one part of a
store cannot be read (its subscriptions, say), that part is reported as failed and the store's other
parts still sync; the run exits 1. A store that asks kit to wait more than a minute before retrying
fails that request with the wait it asked for. A failed step skips the
rest of that product on that store; the summary lists every failure and the run exits 1.

## Credentials

| Store             | Variables                                                                | Needs                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App Store Connect | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (the release secrets) | an API key with App Manager or Admin                                                                                                                                                                                                                                            |
| Google Play       | `PLAY_SERVICE_ACCOUNT_BASE64` (the release secret)                       | the service account invited to the app with permission to manage store presence (products)                                                                                                                                                                                      |
| RevenueCat        | `REVENUECAT_API_KEY` (or `iap.revenuecat.apiKeyEnv`)                     | a v2 secret key (`sk_…`) with `project_configuration:apps:read`, `project_configuration:products:read_write`, `project_configuration:entitlements:read_write`; with offerings also `project_configuration:offerings:read_write` and `project_configuration:packages:read_write` |

`kit doctor` warns per configured store whose variables are missing (`iap-credentials`). A 401 or 403
from a store names what the credentials need.

## What kit never does

Delete, archive, deactivate or detach anything; submit for review; unarchive in RevenueCat; move
existing subscribers to a new price; replace a free trial. Those stay console actions.

## Manual steps, once per app

- **Apple**: the Paid Apps agreement. The first consumable and the first non-consumable each ship with
  a new app version: select them on the version page in App Store Connect and submit. `status` notes
  this until one of that type is approved. The same goes for the first subscription. A product stays `MISSING_METADATA` until it has a review
  screenshot.
- **Google Play**: a payments profile, and an app bundle that declares
  `com.android.vending.BILLING` uploaded to any track (`kit release android --track internal`). When
  Play refuses a product for this, the error says so.
- **RevenueCat**: connect the App Store app (App Store Connect API key and in-app purchase key) and the
  Play Store app (service account) in the project, and give the project's v2 secret key the scopes
  above.

## Scheduled price changes

Apple holds the whole schedule: `sync` sends the current price and each `priceChanges` entry still ahead.
Play has no scheduled prices for one-time products: the first `sync` on or after the date sets the new
price (`status` says when). To make that automatic, run `kit iap sync --store play --yes` in a
scheduled CI job. Once a date has passed, `check` asks you to move the price into `price`.

## Recording a real run

`KIT_IAP_RECORD=<dir>` writes every request and response of a run to `<dir>`, one JSON file each, with
secrets masked (the auth header is never written). Read them before committing any of them.
