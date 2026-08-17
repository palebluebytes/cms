# Changelog

## [0.3.0](https://github.com/palebluebytes/cms/compare/v0.2.0...v0.3.0) (2026-08-17)


### ⚠ BREAKING CHANGES

* the package is now `@palebluebytes/cms`. Every import path changes from `@palebluebytes/google-cms/…` to `@palebluebytes/cms/…`. `@palebluebytes/google-cms@0.2.0` stays published and working, so nothing is forced to migrate.
* **calendar:** `timeMin`/`timeMax` on the calendar options are now `from`/`to`. Same RFC3339 values, same passthrough.
* **calendar:** `CalendarEvent.isAllDay` is replaced by `kind`. A template branching on `isAllDay` branches on `kind === "date"`.
* the entry points are now /files/google and /calendar/google. /drive and /calendar are gone, with no aliases: pre-1.0 with first-party consumers, an import rewrite per site beats a deprecation that never gets removed.

### Features

* **calendar:** read a calendar from any .ics url ([92c2a70](https://github.com/palebluebytes/cms/commit/92c2a70c5811c6cd02e26c09ec01535414304b73))
* **calendar:** read iCalendar text and expand its recurrence rules ([cf22d80](https://github.com/palebluebytes/cms/commit/cf22d80d1cce153d84f8f484604ab8bd2c8bd8dd))
* **calendar:** rename the time window to from and to ([f9168cb](https://github.com/palebluebytes/cms/commit/f9168cb4a1459609332046d890e728ed8b65c8c1))
* **calendar:** replace isAllDay with a four-way kind ([58f53a5](https://github.com/palebluebytes/cms/commit/58f53a53756572ccea7288aa4e825cd5c084b9a8))


### Bug Fixes

* **calendar:** an all-day end equal to the start is one day, not a negative span ([ca08c3e](https://github.com/palebluebytes/cms/commit/ca08c3e37943d781c5af4ce8d0ce005e65aed2c9))
* **page-walk:** say which page was not JSON, and what answered ([8e08ab2](https://github.com/palebluebytes/cms/commit/8e08ab21b8966ccc35039fdec222aba561f1490d))
* **page-walk:** stop the non-JSON error claiming more than it knows ([67efe16](https://github.com/palebluebytes/cms/commit/67efe16e9ac5c0a4684e229443354f2be4df1a44))


### Refactoring

* **calendar:** type EventResource.status as an open union ([5b610c8](https://github.com/palebluebytes/cms/commit/5b610c8d862e3a969b5f1d610981b9ce706c87de))
* deepen the page walk into one internal module ([a05ad58](https://github.com/palebluebytes/cms/commit/a05ad585397c4e25a4e89fdf6171d217cc24e823))
* **drive:** stop the normaliser reporting to the console ([16307e1](https://github.com/palebluebytes/cms/commit/16307e1e34240081e63d29ee2d0650d8ae21f6dc))
* give an authorised request one module ([ad6ae6c](https://github.com/palebluebytes/cms/commit/ad6ae6c33687c76a509784311f651eda2953efcf))
* one directory per resource, one file per provider ([728eaff](https://github.com/palebluebytes/cms/commit/728eaffbb022df36074e4c37cc553b8018ef8509))
* rewrite the package in typescript ([247e173](https://github.com/palebluebytes/cms/commit/247e1730cc2035f391d269066780873f22b48de4))


### Documentation

* add a CONTEXT.md glossary ([0ad9eea](https://github.com/palebluebytes/cms/commit/0ad9eea6f0dbc9aa179c491cdea8971d266a19ed))
* define Resource, and record why it is not a module ([516b025](https://github.com/palebluebytes/cms/commit/516b0250efedf26c8bdf58b938d72c8ff8bfba79))
* document GitHub Packages auth and standardise on pnpm ([9c6bafa](https://github.com/palebluebytes/cms/commit/9c6bafa235eeca3e54246e39206fad5efd97abc4))
* document the typescript build and its traps ([9b87298](https://github.com/palebluebytes/cms/commit/9b87298401569bcda7b28aa6ac726456cc0be9ab))
* point the traps index at what the new area actually holds ([1369ac0](https://github.com/palebluebytes/cms/commit/1369ac0c9ebab5840752127dc94961d03070b6eb))
* record that a resource may have more than one provider ([10652f0](https://github.com/palebluebytes/cms/commit/10652f0179d73d48cb2abc14893bc27dacaf71f0))
* record that the normalisers report nothing ([3ea4a7d](https://github.com/palebluebytes/cms/commit/3ea4a7df054690756ddbd1a2a6a47ea2cc1cef36))
* record why the walk's errors carry no code ([32ef44c](https://github.com/palebluebytes/cms/commit/32ef44cf21095a70c3014a2a45eb37cb082cf5c8))
* split AGENTS.md into progressively disclosed guides ([3fb371b](https://github.com/palebluebytes/cms/commit/3fb371bb8c30ad0eb4c53aba4ba540715ec2e829))
* state when the credential is applied, and where ([d285705](https://github.com/palebluebytes/cms/commit/d28570505149d80287cb1c6ab97aa0ff5685a68a))
* stop the glossary promising a term it never defines ([f869b6c](https://github.com/palebluebytes/cms/commit/f869b6cdf4b621db262bc2a0f4a592535bce69f1))
* survey the service-account prior art, and stop recommending a library that cannot run ([88b44d3](https://github.com/palebluebytes/cms/commit/88b44d31f3212756b83538c33275325159ac3577))


### Build System

* rename the package to @palebluebytes/cms ([b3d607b](https://github.com/palebluebytes/cms/commit/b3d607bfbf6a99d7db5d77d36c8edafd12a49704))
* turn an unused binding into a compile error ([c7e72be](https://github.com/palebluebytes/cms/commit/c7e72be1b6325b4bd79ef58a539ce45d98e94be6))

## [0.2.0](https://github.com/palebluebytes/google-cms/compare/v0.1.0...v0.2.0) (2026-08-16)


### Features

* google drive and calendar as a build-time CMS ([f1fc273](https://github.com/palebluebytes/google-cms/commit/f1fc273642b93e55dfc9b59cc7b687df4153c827))


### Bug Fixes

* **ci:** commit the lockfile and keep Prettier off generated files ([aeecba2](https://github.com/palebluebytes/google-cms/commit/aeecba2be1710f25715ada440fe0b11c6d415131))


### Build System

* **nix:** add a flake devShell with node, pnpm and gh ([0c74c03](https://github.com/palebluebytes/google-cms/commit/0c74c03604130fcb5a6c61529311d6af0ce7c8dd))
* **nix:** pin packageManager to the pnpm the flake ships ([a9fc568](https://github.com/palebluebytes/google-cms/commit/a9fc568d02fa1e830ab0d3a4b3da7f0b019ec8c6))
* raise the supported Node floor to 22 ([cd29781](https://github.com/palebluebytes/google-cms/commit/cd29781183f88f23244475c12d9f30997fdb5259))
