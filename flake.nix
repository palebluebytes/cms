{
  description = "Development shell for @palebluebytes/google-cms";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            # The package targets any JS runtime; Node is only what runs the
            # tests and prettier here. `engines` says >=18, so anything current
            # is fine — this tracks the version the maintainer develops on.
            pkgs.nodejs_24

            # Matches the `packageManager` major pinned in package.json.
            pkgs.pnpm_10

            # The engineering skills in docs/agents/ shell out to `gh` for
            # every issue and triage operation.
            pkgs.gh
          ];
        };
      });
    };
}
