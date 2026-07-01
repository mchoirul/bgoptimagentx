import pytest
from unittest.mock import MagicMock, patch
from google.cloud import bigquery
from app.tools import _dry_run_sync

@patch('app.tools._get_bq_client')
def test_dry_run_sync_enforces_dry_run(mock_get_client):
    # Setup mocks
    mock_client = MagicMock()
    mock_get_client.return_value = mock_client
    
    # Configure mock query job
    mock_job = MagicMock()
    mock_job.total_bytes_scanned = 12345
    mock_client.query.return_value = mock_job
    
    # Run dry run
    result = _dry_run_sync("SELECT * FROM table")
    
    # Verify client.query was called
    mock_client.query.assert_called_once()
    
    # Verify job_config had dry_run=True
    called_args, called_kwargs = mock_client.query.call_args
    job_config = called_kwargs.get('job_config')
    assert job_config is not None
    assert job_config.dry_run is True
    assert job_config.use_query_cache is False
    
    # Verify output matches expected format
    assert result["total_bytes_scanned"] == 12345
    assert "12345" in result["message"]

@patch('app.tools._get_bq_client')
@patch('google.cloud.bigquery.QueryJobConfig')
def test_dry_run_sync_fails_if_dry_run_disabled(mock_query_job_config, mock_get_client):
    # Mock QueryJobConfig to force dry_run to be False
    mock_config_instance = MagicMock()
    mock_config_instance.dry_run = False  # Simulate a bypass or bug
    mock_query_job_config.return_value = mock_config_instance
    
    mock_client = MagicMock()
    mock_get_client.return_value = mock_client
    
    # Verify that a RuntimeError is raised
    with pytest.raises(RuntimeError, match="CRITICAL: Dry-run configuration was bypassed."):
        _dry_run_sync("UPDATE table SET x = 1")
