from unittest.mock import Mock

from app import connectors


def test_postgresql_fields_are_forwarded_to_driver(monkeypatch):
    connect = Mock(return_value="connection")
    monkeypatch.setattr("psycopg.connect", connect)
    assert connectors._postgres_connect({"host":"pg","port":"5433","database":"sales","username":"reader","password":"pw","sslmode":"require"}) == "connection"
    assert connect.call_args.kwargs == {"host":"pg","port":5433,"dbname":"sales","user":"reader","password":"pw","sslmode":"require","connect_timeout":15}


def test_sql_server_builds_odbc_18_encrypted_connection_string():
    value = connectors._sqlserver_connection_string({"host":"sql.example.com","port":"1433","database":"Sales","username":"reader","password":"pw"})
    assert "ODBC Driver 18 for SQL Server" in value
    assert "SERVER=sql.example.com,1433" in value
    assert "DATABASE=Sales" in value and "UID=reader" in value
    assert "Encrypt=yes" in value and "TrustServerCertificate=no" in value


def test_mysql_connection_url_is_parsed_and_tls_is_enabled(monkeypatch):
    connect = Mock(return_value="connection")
    monkeypatch.setattr("pymysql.connect", connect)
    result = connectors._mysql_connect({"connectionString":"mysql://report%20user:p%40ss@mysql.example.com:3307/sales","sslmode":"require"})
    assert result == "connection"
    assert connect.call_args.kwargs["host"] == "mysql.example.com"
    assert connect.call_args.kwargs["port"] == 3307
    assert connect.call_args.kwargs["user"] == "report user"
    assert connect.call_args.kwargs["password"] == "p@ss"
    assert connect.call_args.kwargs["database"] == "sales"
    assert "ssl" in connect.call_args.kwargs


def test_mariadb_uses_mysql_driver_family():
    assert connectors._database_family("mariadb") == "mysql"
