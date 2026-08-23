# OpenSCENARIO runtime conformance corpus

These deterministic OpenSCENARIO 1.4 files are shared contract fixtures for
the public writer and every execution adapter, including the optional local
CARLA adapter and SimCloud's remote render workers.

They cover all supported signal indications, appearance state changes, and
actor despawn semantics. Consumers must compile these exact bytes and produce
deterministic plans. Do not maintain a private copy in a product repository;
consume the files from the published `@simforge/openscenario` package.
