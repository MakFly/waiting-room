variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with Waiting Room edit permission."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone id for the domain."
}

variable "host" {
  type        = string
  description = "Hostname to protect, e.g. shop.exemple.com."
}

variable "path" {
  type        = string
  default     = "/drop"
  description = "Path prefix gated by the waiting room."
}

# --- The two knobs (calibrate C empirically; see README load test) -----------
variable "total_active_users" {
  type        = number
  default     = 500
  description = "Capacity C: max simultaneous active users allowed onto the origin."
}

variable "new_users_per_minute" {
  type        = number
  default     = 200
  description = "Admission throughput λ (≈ C / avg session minutes, Little's Law)."
}

variable "session_duration_minutes" {
  type        = number
  default     = 15
  description = "How long an admitted session stays valid."
}

variable "queueing_method" {
  type        = string
  default     = "random" # random is the anti-bot default for drops
  description = "fifo | random | passthrough | reject."
}
