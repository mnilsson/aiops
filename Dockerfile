FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  ca-certificates \
  openssh-client \
  gnupg \
  lsb-release \
  apt-transport-https \
  python3 \
  python3-pip \
  python3-venv \
  gcc \
  default-libmysqlclient-dev \
  pkg-config \
  unzip \
  && curl -fsSL https://packages.sury.org/php/apt.gpg | gpg --dearmor -o /usr/share/keyrings/sury-php.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/sury-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" > /etc/apt/sources.list.d/sury-php.list \
  && curl -fsSL https://apt.releases.hashicorp.com/gpg | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -sc) main" > /etc/apt/sources.list.d/hashicorp.list \
  && apt-get update && apt-get install -y \
  terraform \
  php8.4-cli \
  php8.4-mbstring \
  php8.4-xml \
  php8.4-sqlite3 \
  php8.4-curl \
  php8.4-zip \
  && update-alternatives --set php /usr/bin/php8.4 \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  version="$(curl -fsSL 'https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest' | jq -r '.tag_name | ltrimstr("v")')"; \
  arch="$(dpkg --print-architecture)"; \
  escaped_version="$(printf '%s' "$version" | sed 's/\./%2E/g')"; \
  curl -fsSL -o /tmp/glab.deb "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${escaped_version}/glab_${escaped_version}_linux_${arch}%2Edeb"; \
  apt-get update; apt-get install -y /tmp/glab.deb; rm -f /tmp/glab.deb; rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  mkdir -p -m 755 /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; apt-get install -y gh; rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer

RUN corepack enable && npm install -g @mariozechner/pi-coding-agent

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN set -eux; \
  if getent group "$AGENT_GID" >/dev/null; then target_group="$(getent group "$AGENT_GID" | cut -d: -f1)"; else groupmod -g "$AGENT_GID" node; target_group="node"; fi; \
  usermod -u "$AGENT_UID" -g "$target_group" -d /home/agent -m -l agent node

USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent/workspace
ENTRYPOINT ["sleep", "infinity"]
