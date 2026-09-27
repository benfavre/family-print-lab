// A small JSON value for the protocol layer: parse, build, serialise to one line. The rpc code and the
// facade's plain structs use it, so nothing outside facade/ depends on upstream's nlohmann copy and the
// protocol layer builds and tests without Bambu Studio.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace printlab {

class Json {
public:
	enum class Type { Null, Bool, Number, String, Array, Object };
	using Array = std::vector<Json>;
	using Object = std::map<std::string, Json>;

	Json() = default;
	Json(std::nullptr_t) {}
	Json(bool b) : type_(Type::Bool), bool_(b) {}
	Json(int n) : type_(Type::Number), num_(n) {}
	Json(long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
	Json(long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
	Json(unsigned n) : type_(Type::Number), num_(n) {}
	Json(unsigned long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
	Json(unsigned long long n) : type_(Type::Number), num_(static_cast<double>(n)) {}
	Json(double n) : type_(Type::Number), num_(n) {}
	Json(const char *s) : type_(Type::String), str_(s) {}
	Json(std::string s) : type_(Type::String), str_(std::move(s)) {}
	Json(Array a) : type_(Type::Array), arr_(std::make_shared<Array>(std::move(a))) {}
	Json(Object o) : type_(Type::Object), obj_(std::make_shared<Object>(std::move(o))) {}

	static Json array() { return Json(Array{}); }
	static Json object() { return Json(Object{}); }

	/** Throws ParseError on anything that is not exactly one JSON value (whitespace around is fine). */
	static Json parse(const std::string &text);

	Type type() const { return type_; }
	bool is_null() const { return type_ == Type::Null; }
	bool is_bool() const { return type_ == Type::Bool; }
	bool is_number() const { return type_ == Type::Number; }
	bool is_string() const { return type_ == Type::String; }
	bool is_array() const { return type_ == Type::Array; }
	bool is_object() const { return type_ == Type::Object; }

	bool as_bool() const;
	double as_number() const;
	/** The number as an integer; throws TypeError when it has a fraction or does not fit. */
	long long as_int() const;
	const std::string &as_string() const;
	const Array &as_array() const;
	Array &as_array();
	const Object &as_object() const;
	Object &as_object();

	/** Object member, or a shared null when missing (never throws on a missing key). */
	const Json &operator[](const std::string &key) const;
	/** Object member, created as null when missing; turns a null value into an object. */
	Json &operator[](const std::string &key);
	const Json &operator[](size_t i) const;
	bool has(const std::string &key) const;
	size_t size() const;
	void push_back(Json v);

	/** One line, no spaces; strings escaped so the output never contains a raw newline. */
	std::string dump() const;

	bool operator==(const Json &o) const;
	bool operator!=(const Json &o) const { return !(*this == o); }

	struct ParseError : std::runtime_error {
		using std::runtime_error::runtime_error;
	};
	struct TypeError : std::runtime_error {
		using std::runtime_error::runtime_error;
	};

private:
	void dump_to(std::string &out) const;
	void make_own(); // copy-on-write for shared arrays/objects

	Type type_ = Type::Null;
	bool bool_ = false;
	double num_ = 0;
	std::string str_;
	std::shared_ptr<Array> arr_;
	std::shared_ptr<Object> obj_;
};

} // namespace printlab
