# `src/discovery/`

Responsible for analyzing existing codebases to bootstrap configuration effortlessly.

### Key Components

- **`ImportTracer`**: Leverages `Tree-sitter` to construct an `Abstract Syntax Tree` of the user's project. It identifies dynamic and static imports to infer the structural relationships between modules.
- **`AutoMap`**: Clusters the traced imports into discrete operational boundaries, generating a topologically sound `b4mal.lock` configuration file.
