{pkgs, ...}: let
  # CI (.github/workflows/ci.yml) and the container images (deploy/) use Node 24.
  # Keep the local shell on the same major so `npm test` / `npm run build` behave the same.
  node = pkgs.nodejs_24;
in {
  packages = [
    node
    pkgs.lefthook
    # README-MVP.md requires ffmpeg / ffprobe 6+ on PATH (H.264 / AAC).
    pkgs.ffmpeg-headless
  ];

  # The project reads its settings from environment variables only (.env.example).
  # No .env auto-loading: keep that contract so local runs match README-MVP.md.

  # `npm install` is still run by hand after the first `devenv shell`; installing
  # dependencies is not a side effect of entering the shell.
  enterShell = ''
    echo "node $(node -v) / npm $(npm -v) / $(ffmpeg -version | head -1)"
    echo "Run project commands as: devenv shell -- <command>"
  '';

  # Git hooks are installed per clone by `npm install` (prepare script) or
  # `npm exec lefthook install`; see README-MVP.md.
}
