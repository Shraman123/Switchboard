# WordPress + a pinned WooCommerce, baked into one image so that the store
# version is just an image tag (helm upgrade --set image.tag=... is the upgrade).
FROM wordpress:7.1.3-php8.3-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG WP_CLI_VERSION=2.12.0

RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends unzip less mariadb-client; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    mkdir -p /opt/store; \
    curl -fsSL -o /opt/store/woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    echo "${WOOCOMMERCE_VERSION}" > /opt/store/woocommerce.version

# Run Apache as www-data (uid 33) on an unprivileged port so the pod can run
# with runAsNonRoot and no added capabilities.
RUN set -eux; \
    sed -ri 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -ri 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    chown -R www-data:www-data /var/run/apache2 /var/lock/apache2 /var/log/apache2

# WordPress core lives in the image (immutable; upgraded by changing the tag).
# Only wp-content is persistent. wp-config.php is the env-driven docker variant,
# so the web pod and the bootstrap Job read DB credentials and salts from the
# same Secret-backed environment.
RUN set -eux;     cp -a /usr/src/wordpress/. /var/www/html/;     cp /usr/src/wordpress/wp-config-docker.php /var/www/html/wp-config.php;     chown -R www-data:www-data /var/www/html

COPY bootstrap.sh seed-content.sh /opt/store/
RUN chmod +x /opt/store/*.sh

USER 33:33
EXPOSE 8080
