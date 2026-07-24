terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Variant B — the queue is enforced at Cloudflare's edge, in front of the origin.
# The origin (the Bun/Hono "real site") needs no queue logic of its own.
resource "cloudflare_waiting_room" "drop" {
  zone_id = var.zone_id
  name    = "product-drop"
  host    = var.host
  path    = var.path # e.g. "/drop" — only these URLs are gated

  # The two knobs, same meaning as variant A:
  total_active_users   = var.total_active_users   # = capacity (C)
  new_users_per_minute = var.new_users_per_minute # = admission throughput (λ)

  session_duration = var.session_duration_minutes # pass validity (minutes)
  queueing_method  = var.queueing_method          # fifo | random | passthrough | reject

  # Serve our own branded page and expose the JSON endpoint the SPA polls.
  json_response_enabled = true
  custom_page_html      = file("${path.module}/waiting.html")

  description                       = "Virtual waiting room for high-demand drops"
  disable_session_renewal           = false
  queue_all                         = false
}
