# WoW Auction Optimizer -- GCP Terraform (Scale-Up Path)
#
# For low-traffic, use the free tier approach in the README.
# This Terraform is for production-scale GCP deployment.

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "blizzard_client_id" {
  description = "Blizzard API client ID (store in Secret Manager)"
  type        = string
  sensitive   = true
}

variable "blizzard_client_secret" {
  description = "Blizzard API client secret (store in Secret Manager)"
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "Cloud SQL password"
  type        = string
  sensitive   = true
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# --- Cloud SQL (Postgres) ---
resource "google_sql_database_instance" "main" {
  name             = "wow-auction-db"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = "db-f1-micro"
    availability_type = "ZONAL"

    disk_size = 10
    disk_type = "PD_SSD"

    backup_configuration {
      enabled = true
    }

    ip_configuration {
      authorized_networks {
        name  = "allow-all"
        value = "0.0.0.0/0"
      }
    }
  }

  deletion_protection = false
}

resource "google_sql_database" "app" {
  name     = "wow_auction"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "app" {
  name     = "wow"
  instance = google_sql_database_instance.main.name
  password = var.db_password
}

# --- Memorystore (Redis) ---
resource "google_redis_instance" "cache" {
  name           = "wow-auction-cache"
  tier           = "BASIC"
  memory_size_gb = 1
  region         = var.region
}

# --- Secret Manager ---
resource "google_secret_manager_secret" "blizzard_id" {
  secret_id = "blizzard-client-id"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "blizzard_id" {
  secret      = google_secret_manager_secret.blizzard_id.id
  secret_data = var.blizzard_client_id
}

resource "google_secret_manager_secret" "blizzard_secret" {
  secret_id = "blizzard-client-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "blizzard_secret" {
  secret      = google_secret_manager_secret.blizzard_secret.id
  secret_data = var.blizzard_client_secret
}

# --- Cloud Run (API) ---
resource "google_cloud_run_v2_service" "api" {
  name     = "wow-auction-api"
  location = var.region

  template {
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/wow-auction/api:latest"

      env {
        name  = "DATABASE_URL"
        value = "postgresql+asyncpg://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
      }
      env {
        name  = "DATABASE_URL_SYNC"
        value = "postgresql://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
      }
      env {
        name  = "REDIS_URL"
        value = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}/0"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
  }
}

# Make API publicly accessible
resource "google_cloud_run_v2_service_iam_member" "api_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.api.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# --- Cloud Run Jobs (Background Jobs) ---
resource "google_cloud_run_v2_job" "ingest" {
  name     = "wow-auction-ingest"
  location = var.region

  template {
    template {
      containers {
        image = "${var.region}-docker.pkg.dev/${var.project_id}/wow-auction/jobs:latest"
        command = ["python", "-m", "services.jobs.ingest"]

        env {
          name  = "DATABASE_URL"
          value = "postgresql+asyncpg://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
        }
        env {
          name  = "DATABASE_URL_SYNC"
          value = "postgresql://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
        }
        env {
          name  = "REDIS_URL"
          value = "redis://${google_redis_instance.cache.host}:${google_redis_instance.cache.port}/0"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
      }
      timeout = "1800s"
    }
  }
}

resource "google_cloud_run_v2_job" "compute" {
  name     = "wow-auction-compute"
  location = var.region

  template {
    template {
      containers {
        image = "${var.region}-docker.pkg.dev/${var.project_id}/wow-auction/jobs:latest"
        command = ["python", "-m", "services.jobs.compute"]

        env {
          name  = "DATABASE_URL"
          value = "postgresql+asyncpg://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
        }
        env {
          name  = "DATABASE_URL_SYNC"
          value = "postgresql://wow:${var.db_password}@${google_sql_database_instance.main.public_ip_address}:5432/wow_auction"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "1Gi"
          }
        }
      }
      timeout = "600s"
    }
  }
}

# --- Cloud Scheduler (Triggers) ---
resource "google_cloud_scheduler_job" "ingest_schedule" {
  name     = "wow-auction-ingest-trigger"
  schedule = "0 * * * *"
  region   = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/wow-auction-ingest:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

resource "google_cloud_scheduler_job" "compute_schedule" {
  name     = "wow-auction-compute-trigger"
  schedule = "5 * * * *"
  region   = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/wow-auction-compute:run"

    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }
}

resource "google_service_account" "scheduler" {
  account_id   = "wow-scheduler"
  display_name = "WoW Auction Scheduler"
}

resource "google_project_iam_member" "scheduler_run_invoker" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# --- Outputs ---
output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "db_ip" {
  value = google_sql_database_instance.main.public_ip_address
}

output "redis_host" {
  value = google_redis_instance.cache.host
}
