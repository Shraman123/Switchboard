#!/usr/bin/env bash
# Idempotent store bootstrap. Runs as a Kubernetes Job (Helm post-install and
# post-upgrade hook) against the same PVC the WordPress pod serves from.
# Every step checks state first, so re-running it is always safe.
set -euo pipefail

export HOME=/tmp
cd /var/www/html
WP="wp --path=/var/www/html --skip-themes"

: "${SITE_URL:?}" "${ADMIN_USER:?}" "${ADMIN_PASSWORD:?}" "${ADMIN_EMAIL:?}"
: "${WC_CONSUMER_KEY:?}" "${WC_CONSUMER_SECRET:?}"
STORE_TITLE="${STORE_TITLE:-Switchboard Demo Store}"
STORE_TIMEZONE="${STORE_TIMEZONE:-Asia/Kolkata}"
STORE_CURRENCY="${STORE_CURRENCY:-INR}"
STORE_COUNTRY="${STORE_COUNTRY:-IN:WB}"

log() { echo "[bootstrap] $*"; }

# wp-content is the persistent volume; seed default themes/plugins on first run.
/opt/store/seed-content.sh

log "waiting for the database"
for i in $(seq 1 90); do
  $WP db check >/dev/null 2>&1 && break
  sleep 2
done

if ! $WP core is-installed 2>/dev/null; then
  log "installing WordPress at $SITE_URL"
  $WP core install --url="$SITE_URL" --title="$STORE_TITLE" \
    --admin_user="$ADMIN_USER" --admin_password="$ADMIN_PASSWORD" \
    --admin_email="$ADMIN_EMAIL" --skip-email
fi

# The URL is configuration, not state: re-apply it so a values change
# (local domain -> VPS domain) takes effect on the next helm upgrade.
$WP option update home "$SITE_URL" >/dev/null
$WP option update siteurl "$SITE_URL" >/dev/null
$WP option update blogname "$STORE_TITLE" >/dev/null
$WP option update timezone_string "$STORE_TIMEZONE" >/dev/null
$WP rewrite structure '/%postname%/' >/dev/null

# Keep the admin password in sync with the Secret (rotation = update Secret + upgrade).
$WP user update "$ADMIN_USER" --user_pass="$ADMIN_PASSWORD" --skip-email >/dev/null

WANT_WC="$(cat /opt/store/woocommerce.version)"
HAVE_WC="$($WP plugin get woocommerce --field=version 2>/dev/null || echo none)"
if [ "$HAVE_WC" != "$WANT_WC" ]; then
  log "installing WooCommerce $WANT_WC (had: $HAVE_WC)"
  $WP plugin install /opt/store/woocommerce.zip --force
fi
$WP plugin is-active woocommerce || $WP plugin activate woocommerce
# Run any pending WooCommerce database migrations (needed after an upgrade).
wp --path=/var/www/html wc update --user=1 >/dev/null 2>&1 || true

# Themes are loaded from here on (the storefront theme ships in WP core).
WPT="wp --path=/var/www/html"

log "configuring store settings"
$WPT option update woocommerce_default_country "$STORE_COUNTRY" >/dev/null
$WPT option update woocommerce_currency "$STORE_CURRENCY" >/dev/null
$WPT option update woocommerce_coming_soon no >/dev/null
$WPT option update woocommerce_store_pages_only no >/dev/null
$WPT option update woocommerce_onboarding_profile '{"skipped":true}' --format=json >/dev/null
# No physical shipping in the demo: checkout should never block on shipping zones.
$WPT option update woocommerce_ship_to_countries disabled >/dev/null
$WPT option update woocommerce_calc_taxes no >/dev/null
$WPT option update woocommerce_enable_guest_checkout yes >/dev/null
# Cash on delivery is the test-friendly payment method.
$WPT option update woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json >/dev/null

# Cart / checkout / my-account pages (no-op when they already exist).
$WPT wc tool run install_pages --user=1 >/dev/null 2>&1 || true

log "ensuring REST API key for the MCP server"
# The key pair is generated outside WordPress (in a Kubernetes Secret) and
# registered here, so the MCP server and the store read the same Secret and the
# key never has to be copied out of wp-admin by hand.
WC_CONSUMER_KEY="$WC_CONSUMER_KEY" WC_CONSUMER_SECRET="$WC_CONSUMER_SECRET" $WPT eval '
  global $wpdb;
  $ck = getenv("WC_CONSUMER_KEY"); $cs = getenv("WC_CONSUMER_SECRET");
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $hash = wc_api_hash($ck);
  $wpdb->query($wpdb->prepare("DELETE FROM $table WHERE description = %s AND consumer_key <> %s", "switchboard-mcp", $hash));
  $exists = $wpdb->get_var($wpdb->prepare("SELECT key_id FROM $table WHERE consumer_key = %s", $hash));
  if (!$exists) {
    $wpdb->insert($table, array(
      "user_id" => 1, "description" => "switchboard-mcp", "permissions" => "read_write",
      "consumer_key" => $hash, "consumer_secret" => $cs, "truncated_key" => substr($ck, -7),
    ));
    echo "created\n";
  } else { echo "present\n"; }
'

if [ "$($WPT post list --post_type=product --format=count)" = "0" ]; then
  log "seeding sample products"
  for p in "Darjeeling First Flush Tea|450" "Kolkata Rosogolla Box|299" "Handloom Tant Saree|1850"; do
    $WPT wc product create --user=1 --name="${p%%|*}" --regular_price="${p##*|}" --status=publish >/dev/null
  done
fi

$WPT rewrite flush >/dev/null 2>&1 || true
$WPT cache flush >/dev/null 2>&1 || true
log "done: $SITE_URL"
